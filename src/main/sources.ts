/**
 * 外部书目源（OPDS）
 *
 * 做三件事：抓 Atom 目录、把条目变成 CatalogItem、把选中的书用 calibredb 加进书库。
 * 零新依赖：main 里没有 DOM，Atom 用手写扫描，够用就行，不建整棵 XML 树。
 *
 * 两段式目录（Project Gutenberg 就是这种）：
 *   搜索/浏览 feed 的条目只有 rel="subsection" 指向这本书自己的详情 feed，
 *   真正的下载链接（rel="http://opds-spec.org/acquisition"）在详情 feed 里。
 * 所以列表阶段要并发补一遍详情，把封面和下载地址拿到；某本详情拿不到就跳过它，
 * 不能让整页报错。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, ipcMain, net } from 'electron'
import { CH } from '../shared/ipc'
import type { BookSource, CatalogItem, CatalogPage } from '../shared/types'
import { ctx } from './ctx'
import { calibreExe, isCalibreRunning } from './env'

const run = promisify(execFile)

/** 目录 feed 一次请求的上限 */
const FEED_TIMEOUT_MS = 15_000
/** 补详情时单本的上限，短一点：一本超时不能拖住整页 */
const DETAIL_TIMEOUT_MS = 8_000
/** 下载整本书（Gutenberg 带图 EPUB 常有 5–10MB） */
const DOWNLOAD_TIMEOUT_MS = 180_000
/** 补详情的并发数；再大 Gutenberg 会开始变慢 */
const DETAIL_CONCURRENCY = 10
/** 目录缓存 5 分钟，翻页来回点不重复请求 */
const CACHE_TTL_MS = 5 * 60_000
const USER_AGENT = 'eebookk (OPDS client; +https://www.gutenberg.org/)'
const FEED_ACCEPT = 'application/atom+xml, application/xml;q=0.9, */*;q=0.8'

const ACQ_REL = 'http://opds-spec.org/acquisition'
const IMAGE_REL = 'http://opds-spec.org/image'

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

type FetchResult = { ok: true; text: string } | { ok: false; error: string }

const feedCache = new Map<string, { at: number; text: string }>()
/** 同一个地址正在请求时，后到的人直接等这一份，别重复打站点 */
const inflight = new Map<string, Promise<FetchResult>>()

function cacheFeed(url: string, text: string): void {
  const now = Date.now()
  if (feedCache.size > 200) {
    for (const [key, row] of feedCache) if (now - row.at >= CACHE_TTL_MS) feedCache.delete(key)
    // 极端情况（开着几百个源乱点）直接清空，别把内存吃满
    if (feedCache.size > 400) feedCache.clear()
  }
  feedCache.set(url, { at: now, text })
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function httpError(status: number): string {
  if (status === 401 || status === 403) return `站点拒绝访问（HTTP ${status}），这个源可能要登录或被拦截`
  if (status === 404) return '地址不存在（HTTP 404）'
  if (status === 429) return '请求太频繁（HTTP 429），等一会儿再试'
  if (status >= 500) return `站点出错了（HTTP ${status}），过一会儿再试`
  return `站点返回 HTTP ${status}`
}

/** 把 fetch 抛出来的英文异常翻译成人话 */
function netError(e: unknown, url: string): string {
  const err = e as { name?: string; message?: string }
  const host = hostOf(url)
  const name = err?.name ?? ''
  const msg = err?.message ?? ''
  if (name === 'TimeoutError' || name === 'AbortError') return `连 ${host} 超时了，站点没有响应`
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return `解析不了 ${host}，可能是断网或 DNS 不通`
  if (/ECONNREFUSED/i.test(msg)) return `${host} 拒绝连接`
  if (/ECONNRESET|socket hang up/i.test(msg)) return `和 ${host} 的连接被中断了`
  if (/CERT|SSL|TLS/i.test(msg)) return `和 ${host} 的 HTTPS 握手失败`
  return `连不上 ${host}${msg ? `（${msg}）` : ''}`
}

async function fetchText(url: string, timeoutMs: number, useCache = true): Promise<FetchResult> {
  if (useCache) {
    const hit = feedCache.get(url)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, text: hit.text }
  }
  const pending = inflight.get(url)
  if (pending) return pending
  const task = (async (): Promise<FetchResult> => {
    try {
      const res = await net.fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': USER_AGENT, Accept: FEED_ACCEPT }
      })
      if (!res.ok) return { ok: false, error: httpError(res.status) }
      const text = await res.text()
      cacheFeed(url, text)
      return { ok: true, text }
    } catch (e) {
      return { ok: false, error: netError(e, url) }
    }
  })()
  inflight.set(url, task)
  try {
    return await task
  } finally {
    inflight.delete(url)
  }
}

/* ------------------------------------------------------------------ */
/* Atom 扫描                                                           */
/* ------------------------------------------------------------------ */

interface RawLink {
  rel: string
  href: string
  type: string
  title: string
  length: number
}

interface RawEntry {
  id: string
  title: string
  authors: string
  summary: string
  language: string
  links: RawLink[]
}

interface ParsedFeed {
  title: string
  next: string | null
  entries: RawEntry[]
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö',
  szlig: 'ß', ntilde: 'ñ'
}

function decodeEntities(src: string): string {
  return src.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
      return whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 元素内部的纯文本：去 CDATA 壳、去标签、解实体、压空白 */
function textOf(raw: string): string {
  let s = raw.trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(s)
  if (cdata) s = cdata[1]
  s = s.replace(/<[^>]*>/g, ' ')
  s = decodeEntities(s)
  return s.replace(/\s+/g, ' ').trim()
}

/** 取第一个匹配到的子元素内容（名字可以带命名空间前缀） */
function pickInner(block: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')
    const m = re.exec(block)
    if (m) return m[1]
  }
  return null
}

/** 取所有同名子元素内容 */
function allInner(block: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) out.push(m[1])
  return out
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '')
  }
  return out
}

function extractLinks(block: string): RawLink[] {
  const links: RawLink[] = []
  const re = /<link\b([^>]*?)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) {
    const attrs = parseAttrs(m[1])
    if (!attrs.href) continue
    const length = Number.parseInt(attrs.length ?? '', 10)
    links.push({
      rel: (attrs.rel ?? '').trim(),
      href: attrs.href.trim(),
      type: (attrs.type ?? '').trim(),
      title: (attrs.title ?? '').trim(),
      length: Number.isFinite(length) ? length : 0
    })
  }
  return links
}

function absolute(href: string, base: string): string {
  if (/^(data|mailto|javascript):/i.test(href)) return href
  try {
    return new URL(href, base).toString()
  } catch {
    return href
  }
}

/** 详情页的 content 通常把整页信息都塞进来，只留 Summary 那段 */
function summaryText(raw: string, title: string): string {
  let s = textOf(raw)
  const m = /Summary:\s*([\s\S]*?)(?:\s*(?:Reading Level|Author:|EBook No\.|Language:|Subject:|LoCC:))/i.exec(s)
  if (m) {
    s = m[1]
  } else {
    s = s.replace(/^This edition (?:has images|had all images removed)\.\s*/i, '')
    if (title) s = s.replace(new RegExp(`^Title:\\s*${escapeRegExp(title)}\\s*`, 'i'), '')
  }
  s = s.replace(/\(This is an automatically generated summary\.\)/i, '')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > 600) s = `${s.slice(0, 600).trimEnd()}…`
  return s
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseEntry(block: string, baseUrl: string): RawEntry {
  const idRaw = pickInner(block, ['id'])
  const titleRaw = pickInner(block, ['title', 'dc:title', 'dcterms:title'])
  const title = titleRaw ? textOf(titleRaw) : ''
  const authors = allInner(block, 'author')
    .map((a) => {
      const name = pickInner(a, ['name', 'dc:creator'])
      return name ? textOf(name) : ''
    })
    .filter(Boolean)
    .join(' & ')
  const summaryRaw = pickInner(block, ['summary', 'content', 'dc:description', 'dcterms:abstract'])
  const langRaw = pickInner(block, ['dcterms:language', 'dc:language', 'language'])
  return {
    id: idRaw ? textOf(idRaw) : '',
    title,
    authors,
    summary: summaryRaw ? summaryText(summaryRaw, title) : '',
    language: langRaw ? textOf(langRaw) : '',
    links: extractLinks(block).map((l) => ({ ...l, href: absolute(l.href, baseUrl) }))
  }
}

function parseFeed(xml: string, baseUrl: string): ParsedFeed {
  const entries: RawEntry[] = []
  const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) entries.push(parseEntry(m[1], baseUrl))

  // feed 级的 link（next / self）在 entry 之外，先挖掉 entry 再扫
  const head = xml.replace(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi, '')
  const titleRaw = pickInner(head, ['title'])
  const nextLink = extractLinks(head).find((l) => l.rel.toLowerCase() === 'next')
  return {
    title: titleRaw ? textOf(titleRaw) : '',
    next: nextLink ? absolute(nextLink.href, baseUrl) : null,
    entries
  }
}

/* ------------------------------------------------------------------ */
/* OPDS 语义                                                           */
/* ------------------------------------------------------------------ */

interface Acq {
  href: string
  type: string
  title: string
  length: number
}

interface Resolved {
  entry: RawEntry
  acq: Acq
  cover: string | null
}

function isAcqRel(rel: string): boolean {
  const r = rel.toLowerCase()
  return r === ACQ_REL || r.startsWith(`${ACQ_REL}/`)
}

function acquisitions(links: RawLink[]): Acq[] {
  return links
    .filter((l) => isAcqRel(l.rel))
    .map((l) => ({ href: l.href, type: l.type, title: l.title, length: l.length }))
}

/**
 * 挑最好的下载链接：EPUB 优先 → 带图的优先（Gutenberg 有 .epub.noimages）→ 文件大的优先。
 * 只用 length 排，不做 HEAD 探测，快。
 */
function acquisitionRank(a: Acq): number {
  const epub = /epub/i.test(a.type) || /\.epub\b/i.test(a.href)
  const noImages = /no[-_ ]?images/i.test(`${a.title} ${a.href}`)
  return (epub ? 1e12 : 0) + (noImages ? 0 : 1e10) + Math.min(a.length, 9_999_999_999)
}

function bestAcq(list: Acq[]): Acq {
  return list.slice().sort((a, b) => acquisitionRank(b) - acquisitionRank(a))[0]
}

function formatOf(acq: Acq): string {
  if (/epub/i.test(acq.type) || /\.epub\b/i.test(acq.href)) return 'epub'
  if (/pdf/i.test(acq.type) || /\.pdf\b/i.test(acq.href)) return 'pdf'
  if (/mobi/i.test(acq.type) || /\.mobi\b/i.test(acq.href)) return 'mobi'
  if (/azw3/i.test(acq.type) || /\.azw3\b/i.test(acq.href)) return 'azw3'
  const ext = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(acq.href)
  return ext ? ext[1].toLowerCase() : 'epub'
}

/** 封面只认 http(s)，列表里那些 data: 通用图标不要 */
function coverOf(entry: RawEntry): string | null {
  const web = entry.links.filter((l) => /^https?:\/\//i.test(l.href))
  const image = web.find((l) => l.rel.toLowerCase() === IMAGE_REL)
  if (image) return image.href
  const thumb = web.find((l) => l.rel.toLowerCase() === `${IMAGE_REL}/thumbnail`)
  return thumb ? thumb.href : null
}

function subsectionHref(links: RawLink[]): string | null {
  const sub = links.find((l) => l.rel.toLowerCase() === 'subsection' && /^https?:\/\//i.test(l.href))
  if (sub) return sub.href
  const alt = links.find(
    (l) =>
      l.rel.toLowerCase() === 'alternate' &&
      /atom|opds/i.test(l.type) &&
      /^https?:\/\//i.test(l.href)
  )
  return alt ? alt.href : null
}

function looksLikeFeed(url: string): boolean {
  return /^https?:\/\//i.test(url) && (/opds/i.test(url) || /\.(atom|xml)(?:[?#]|$)/i.test(url))
}

function httpIdOf(entry: RawEntry): string | null {
  return /^https?:\/\//i.test(entry.id) ? entry.id : null
}

/**
 * 抓详情 feed 并选出可用下载链接。
 * 返回 null 的两种情况：请求失败、或者这份 feed 根本没有 acquisition（是分类/导航页）。
 * 两种都意味着“这条不是能直接下载的书”，调用方跳过。
 */
async function resolveDetail(url: string): Promise<Resolved | null> {
  const res = await fetchText(url, DETAIL_TIMEOUT_MS)
  if (!res.ok) return null
  const feed = parseFeed(res.text, url)
  const pairs: { entry: RawEntry; acq: Acq }[] = []
  for (const entry of feed.entries) {
    for (const acq of acquisitions(entry.links)) pairs.push({ entry, acq })
  }
  if (!pairs.length) return null
  pairs.sort((a, b) => acquisitionRank(b.acq) - acquisitionRank(a.acq))
  const best = pairs[0]
  const cover =
    coverOf(best.entry) ??
    feed.entries.map(coverOf).find((c): c is string => Boolean(c)) ??
    null
  return { entry: best.entry, acq: best.acq, cover }
}

/* ------------------------------------------------------------------ */
/* 条目 -> CatalogItem                                                 */
/* ------------------------------------------------------------------ */

const itemIndex = new Map<string, CatalogItem>()

/** 记住这次列表里的书，点下载时不用再猜它的下载地址 */
function remember(item: CatalogItem): void {
  itemIndex.set(item.id, item)
  if (itemIndex.size > 500) {
    const oldest = itemIndex.keys().next().value
    if (oldest) itemIndex.delete(oldest)
  }
}

function itemFromDetail(
  source: BookSource,
  id: string,
  detail: Resolved,
  base: RawEntry | null
): CatalogItem {
  const entry = detail.entry
  return {
    id,
    sourceId: source.id,
    sourceName: source.name,
    title: entry.title || base?.title || '未命名',
    authors: entry.authors || base?.authors || '',
    cover: detail.cover,
    summary: entry.summary || base?.summary || '',
    downloadUrl: detail.acq.href,
    format: formatOf(detail.acq),
    sizeBytes: detail.acq.length,
    language: entry.language || base?.language || ''
  }
}

function itemFromEntry(source: BookSource, entry: RawEntry, acq: Acq): CatalogItem {
  return {
    id: httpIdOf(entry) ?? acq.href,
    sourceId: source.id,
    sourceName: source.name,
    title: entry.title || urlTitle(acq.href),
    authors: entry.authors,
    cover: coverOf(entry),
    summary: entry.summary,
    downloadUrl: acq.href,
    format: formatOf(acq),
    sizeBytes: acq.length,
    language: entry.language
  }
}

function urlTitle(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
    return name || '未命名'
  } catch {
    return '未命名'
  }
}

function itemFromUrl(source: BookSource, url: string): CatalogItem {
  return {
    id: url,
    sourceId: source.id,
    sourceName: source.name,
    title: urlTitle(url),
    authors: '',
    cover: null,
    summary: '',
    downloadUrl: url,
    format: formatOf({ href: url, type: '', title: '', length: 0 }),
    sizeBytes: 0,
    language: ''
  }
}

/* ------------------------------------------------------------------ */
/* 并发小工具                                                          */
/* ------------------------------------------------------------------ */

async function mapLimit<T, R>(
  list: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(list.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), list.length) }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= list.length) return
      out[i] = await fn(list[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/* ------------------------------------------------------------------ */
/* 设置里的源                                                          */
/* ------------------------------------------------------------------ */

function listSources(): BookSource[] {
  const stored = ctx.settings?.get().sources
  if (!Array.isArray(stored)) return []
  return stored.map((s) => ({ ...s }))
}

function findSource(id: string): BookSource | null {
  return listSources().find((s) => s.id === id) ?? null
}

/**
 * 整组写回。内置源（builtin）不可删、id 和名字不可改，只能改地址和启用状态；
 * 自定义源整条由渲染层决定，去掉就是删除。
 */
function saveSources(incoming: BookSource[]): BookSource[] {
  const store = ctx.settings
  if (!store) return listSources()
  const stored = store.get().sources ?? []
  const byId = new Map(stored.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const next: BookSource[] = []

  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id || seen.has(id)) continue
    const prev = byId.get(id)
    const builtin = Boolean(prev?.builtin || raw.builtin)
    const url = String(raw.url ?? '').trim() || prev?.url || ''
    const searchUrl = String(raw.searchUrl ?? '').trim() || prev?.searchUrl || ''
    // 自定义源两条地址都空着就没法用，直接丢掉
    if (!builtin && !url && !searchUrl) continue
    seen.add(id)
    next.push({
      id: builtin && prev ? prev.id : id,
      name: (builtin && prev ? prev.name : String(raw.name ?? '').trim()) || id,
      kind: 'opds',
      url,
      searchUrl,
      enabled: Boolean(raw.enabled),
      ...(builtin ? { builtin: true } : {})
    })
  }

  // 内置源在数组里漏了也不能算删掉，补回原样（保留用户改过的 url/enabled）
  for (const s of stored) {
    if (!s.builtin || seen.has(s.id)) continue
    next.push({ ...s })
    seen.add(s.id)
  }

  // SettingsStore.update() 目前没有 sources 分支；先改内存里的设置对象，
  // 再用一次空 patch 让它落盘（update 结尾会 persist）。
  store.get().sources = next
  store.update({})
  return next.map((s) => ({ ...s }))
}

/* ------------------------------------------------------------------ */
/* 浏览 / 搜索                                                         */
/* ------------------------------------------------------------------ */

function failPage(sourceId: string, error: string): CatalogPage {
  return { sourceId, items: [], next: null, error }
}

function searchUrlOf(source: BookSource, query: string): string {
  const q = query.trim()
  const tpl = source.searchUrl.trim()
  if (tpl.includes('{q}')) return tpl.replace(/\{q\}/g, encodeURIComponent(q))
  if (tpl) {
    const sep = tpl.includes('?') ? '&' : '?'
    return `${tpl}${sep}query=${encodeURIComponent(q)}`
  }
  const base = source.url.trim()
  if (!base) return ''
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}search?query=${encodeURIComponent(q)}`
}

/**
 * 拉一页目录。
 * depth 只用于“根目录全是分类”的情况：Gutenberg 的 /ebooks.opds/ 只有
 * Popular / Latest / Random 三个跳转，第一次打开随便看看时自动进第一个，
 * 不然界面上什么都看不到。只往下走一层，不会无限递归。
 */
async function buildPage(source: BookSource, url: string, depth: number): Promise<CatalogPage> {
  const res = await fetchText(url, FEED_TIMEOUT_MS)
  if (!res.ok) return failPage(source.id, res.error)
  if (!/<feed[\s>]/i.test(res.text) && !/<entry[\s>]/i.test(res.text)) {
    return failPage(source.id, '这个地址返回的不是 OPDS 目录（看起来是网页）')
  }

  const feed = parseFeed(res.text, url)
  if (!feed.entries.length) return { sourceId: source.id, items: [], next: feed.next }

  const items = (
    await mapLimit(feed.entries, DETAIL_CONCURRENCY, async (entry) => {
      const direct = acquisitions(entry.links)
      if (direct.length) {
        const item = itemFromEntry(source, entry, bestAcq(direct))
        remember(item)
        return item
      }
      // 两段式：subsection 指向这本书的详情 feed，下载地址在那里
      const detailUrl = subsectionHref(entry.links) ?? (looksLikeFeed(entry.id) ? entry.id : null)
      if (!detailUrl) return null
      const detail = await resolveDetail(detailUrl)
      if (!detail) return null
      const item = itemFromDetail(source, detailUrl, detail, entry)
      remember(item)
      return item
    })
  ).filter((x): x is CatalogItem => Boolean(x))

  if (!items.length && depth === 0) {
    const firstSub = feed.entries
      .map((e) => subsectionHref(e.links))
      .find((h): h is string => Boolean(h))
    if (firstSub && firstSub !== url) {
      const sub = await buildPage(source, firstSub, depth + 1)
      if (sub.items.length) return sub
      return failPage(source.id, sub.error ?? '这个目录里只有分类，没有能直接下载的书')
    }
  }

  return { sourceId: source.id, items, next: feed.next }
}

async function browse(sourceId: string, pageUrl?: string): Promise<CatalogPage> {
  const source = findSource(sourceId)
  if (!source) return failPage(sourceId, '找不到这个书目源，可能已经被删掉了')
  if (!source.enabled) return failPage(sourceId, `「${source.name}」已停用，先到设置里打开`)
  const url = pageUrl?.trim() || source.url.trim()
  if (!url) return failPage(sourceId, `「${source.name}」还没填目录地址`)
  try {
    return await buildPage(source, url, 0)
  } catch (e) {
    // 兜底：任何没预料到的异常都不能把渲染层弄崩
    return failPage(sourceId, e instanceof Error ? e.message : '拉取目录失败')
  }
}

async function search(sourceId: string, query: string): Promise<CatalogPage> {
  const source = findSource(sourceId)
  if (!source) return failPage(sourceId, '找不到这个书目源，可能已经被删掉了')
  if (!source.enabled) return failPage(sourceId, `「${source.name}」已停用，先到设置里打开`)
  if (!query.trim()) return failPage(sourceId, '搜索词是空的')
  const url = searchUrlOf(source, query)
  if (!url) return failPage(sourceId, `「${source.name}」还没填搜索地址`)
  try {
    const page = await buildPage(source, url, 1)
    if (!page.items.length && !page.error) {
      return failPage(sourceId, '没有搜到能直接下载的书，换个关键词试试')
    }
    return page
  } catch (e) {
    return failPage(sourceId, e instanceof Error ? e.message : '搜索失败')
  }
}

/* ------------------------------------------------------------------ */
/* 下载入库                                                            */
/* ------------------------------------------------------------------ */

function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || `book-${Date.now()}`
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function calibredbFailure(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string; message?: string }
  const raw = (err.stderr || err.stdout || err.message || '').trim()
  if (!raw) return 'calibredb 没给出原因'
  const line =
    raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .find((s) => !/^Traceback|^\s*File "|^\s{2,}/.test(s)) ?? raw
  return line.slice(0, 300)
}

function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head>')
}

async function downloadItem(
  sourceId: string,
  itemId: string
): Promise<{ ok: boolean; message: string }> {
  const fail = (message: string): { ok: false; message: string } => ({ ok: false, message })

  const source = findSource(sourceId)
  if (!source) return fail('找不到这个书目源，可能已经被删掉了')
  if (!source.enabled) return fail(`「${source.name}」已停用，先到设置里打开`)
  if (!itemId) return fail('没有指定要下载哪本书')

  const lib = ctx.ensureLibrary()
  if (!lib?.isReady) return fail('书库还没就绪，先到设置里选好书库路径')

  // calibre 主程序开着时 calibredb 会拒绝一切写入，先挡掉，别让用户等完下载才失败
  if (await isCalibreRunning()) return fail('calibre 正在运行，先关掉 calibre 再下载')
  ctx.calibreRunning = false

  let item = itemIndex.get(itemId) ?? null
  if (!item) {
    if (looksLikeFeed(itemId)) {
      const detail = await resolveDetail(itemId)
      if (!detail) return fail('拿不到这本书的下载地址，详情页可能已经变了')
      item = itemFromDetail(source, itemId, detail, null)
      remember(item)
    } else if (/^https?:\/\//i.test(itemId)) {
      item = itemFromUrl(source, itemId)
    } else {
      return fail('这本书的下载地址无效，回列表重新点一次')
    }
  }
  if (!item.downloadUrl) return fail(`《${item.title}》没有可下载的 EPUB`)

  const title = item.title
  const acqUrl = item.downloadUrl
  let buf: Buffer
  try {
    const res = await net.fetch(acqUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT }
    })
    if (!res.ok) return fail(`下载《${title}》失败：${httpError(res.status)}`)
    buf = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    return fail(`下载《${title}》失败：${netError(e, acqUrl)}`)
  }
  if (buf.length < 1024) return fail(`《${title}》下载到的文件是空的`)
  if (looksLikeHtml(buf)) return fail(`《${title}》下载到的是网页，不是电子书，源站的地址可能变了`)

  const dir = join(app.getPath('userData'), 'downloads')
  const file = join(dir, `${safeFileName(title)}.${item.format || 'epub'}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, buf)
  } catch (e) {
    return fail(`下载好了但写临时文件失败：${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    // 下载这几秒里 calibre 可能被打开，写库前再查一次
    if (await isCalibreRunning()) {
      return fail(`《${title}》下载好了，但 calibre 正在运行，加不进书库。关掉 calibre 再试。`)
    }
    await run(calibreExe('calibredb'), ['add', file, '--with-library', lib.root], {
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    })
  } catch (e) {
    return fail(`《${title}》下载好了，但加进书库失败：${calibredbFailure(e)}`)
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* 临时文件删不掉不影响结果，下次下载会覆盖 */
    }
  }

  ctx.reload()
  return { ok: true, message: `《${title}》已加入书库（${humanSize(buf.length)}）` }
}

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

export function registerSources(): void {
  ipcMain.handle(CH.sourcesList, () => listSources())
  ipcMain.handle(CH.sourcesSave, (_e, sources: BookSource[]) => saveSources(sources))
  ipcMain.handle(CH.sourcesBrowse, (_e, sourceId: string, pageUrl?: string) => browse(sourceId, pageUrl))
  ipcMain.handle(CH.sourcesSearch, (_e, sourceId: string, query: string) => search(sourceId, query))
  ipcMain.handle(CH.sourcesDownload, async (_e, sourceId: string, itemId: string) => {
    try {
      return await downloadItem(sourceId, itemId)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '下载失败' }
    }
  })
}
