/**
 * 全网元数据 / 封面检索
 *
 * 两个源：豆瓣（网页 + json 建议接口）和 NeoDB（公开 API）。两边都只做读操作，
 * 拿到书以后交给详情页去填元数据 / 换封面。
 *
 * 封面要给出真实像素：把图下载下来自己读文件头算宽高（JPEG / PNG / WebP / GIF），
 * 不引依赖、也不信 URL 里带的尺寸。用户按「哪张最清楚」来挑，所以这个数必须是真的。
 *
 * 网络一律不抛异常：搜索失败就当这个源没结果，换封面失败返回 { ok:false, message }。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, ipcMain, net } from 'electron'
import { CH } from '../shared/ipc'
import type { WebMetaHit, WebMetaSettings } from '../shared/types'
import { ctx } from './ctx'
import { calibreExe, isCalibreRunning } from './env'

const run = promisify(execFile)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DOUBAN_HOST = 'https://book.douban.com'
const NEODB_HOST = 'https://neodb.social'

const TEXT_TIMEOUT_MS = 15_000
const IMAGE_TIMEOUT_MS = 10_000
const IMAGE_MAX_BYTES = 3 * 1024 * 1024
/** 换封面时允许大一点，豆瓣大图常有 1–3MB，别把正常大图挡掉 */
const APPLY_MAX_BYTES = 12 * 1024 * 1024
const CACHE_TTL_MS = 10 * 60_000
/** 豆瓣两个请求之间至少隔这么久，别把对方打挂 */
const DOUBAN_GAP_MS = 420
/** 豆瓣搜索补几条详情（每条一次 subject 页请求，串行 + 限速） */
const DOUBAN_ENRICH = 4
const DOUBAN_MAX_HITS = 6
const NEODB_MAX_HITS = 8
const COVER_CONCURRENCY = 4

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* 请求 / 缓存                                                         */
/* ------------------------------------------------------------------ */

interface CachedText {
  at: number
  text: string
  url: string
}

const textCache = new Map<string, CachedText>()

type TextResult = { ok: true; text: string; url: string } | { ok: false; error: string }

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function httpError(status: number): string {
  if (status === 401 || status === 403) return `站点拒绝访问（HTTP ${status}）`
  if (status === 404) return '地址不存在（HTTP 404）'
  if (status === 429) return '请求太频繁（HTTP 429）'
  if (status >= 500) return `站点出错了（HTTP ${status}）`
  return `站点返回 HTTP ${status}`
}

function netError(e: unknown, url: string): string {
  const err = e as { name?: string; message?: string }
  const host = hostOf(url)
  const name = err?.name ?? ''
  const msg = err?.message ?? ''
  if (name === 'TimeoutError' || name === 'AbortError') return `连 ${host} 超时了，站点没有响应`
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED/i.test(msg)) return `解析不了 ${host}`
  if (/ECONNREFUSED/i.test(msg)) return `${host} 拒绝连接`
  if (/ECONNRESET|socket hang up/i.test(msg)) return `和 ${host} 的连接被中断了`
  if (/CERT|SSL|TLS/i.test(msg)) return `和 ${host} 的 HTTPS 握手失败`
  return `连不上 ${host}${msg ? `（${msg}）` : ''}`
}

function doubanHeaders(accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'): Record<string, string> {
  return {
    Accept: accept,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    // 豆瓣没有 Referer 会 403
    Referer: `${DOUBAN_HOST}/`
  }
}

function neodbHeaders(): Record<string, string> {
  return { Accept: 'application/json' }
}

function imageHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }
  if (/doubanio\.com/i.test(url)) headers.Referer = `${DOUBAN_HOST}/`
  return headers
}

async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = TEXT_TIMEOUT_MS
): Promise<TextResult> {
  const hit = textCache.get(url)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, text: hit.text, url: hit.url }
  try {
    const res = await net.fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, ...headers }
    })
    if (!res.ok) return { ok: false, error: httpError(res.status) }
    const text = await res.text()
    const finalUrl = res.url || url
    textCache.set(url, { at: Date.now(), text, url: finalUrl })
    if (textCache.size > 300) {
      const now = Date.now()
      for (const [key, row] of textCache) if (now - row.at >= CACHE_TTL_MS) textCache.delete(key)
      if (textCache.size > 600) textCache.clear()
    }
    return { ok: true, text, url: finalUrl }
  } catch (e) {
    return { ok: false, error: netError(e, url) }
  }
}

/* ------------------------------------------------------------------ */
/* 豆瓣限速：串行队列 + 间隔                                           */
/* ------------------------------------------------------------------ */

let doubanLast = 0
let doubanChain: Promise<void> = Promise.resolve()

function doubanGate(): Promise<void> {
  const task = doubanChain.then(async () => {
    const gap = Date.now() - doubanLast
    if (gap < DOUBAN_GAP_MS) await sleep(DOUBAN_GAP_MS - gap)
    doubanLast = Date.now()
  })
  doubanChain = task.catch(() => undefined)
  return task
}

/* ------------------------------------------------------------------ */
/* 文本清洗 / 小工具                                                    */
/* ------------------------------------------------------------------ */

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

/**
 * HTML → 纯文本；<br>/段落转成换行，实体解码，行首尾空白去掉。
 * 先把换行位置打成占位符，再把源码里所有空白压成一个空格 —— 豆瓣标签和值之间
 * 隔着一堆源码缩进，不压掉的话「作者:」和作者名会被拆成两行。
 */
function htmlToText(html: string): string {
  const BR = '\u0001'
  let s = html.replace(/<br\s*\/?>/gi, BR).replace(/<\/(p|div|li|h\d|tr)>/gi, BR)
  s = s.replace(/<[^>]*>/g, ' ')
  s = decodeEntities(s).replace(/\u00a0/g, ' ')
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/\s*\u0001\s*/g, '\n')
  return s
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function cleanInline(raw: string): string {
  return decodeEntities(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

function asTextArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asText).filter(Boolean)
  const one = asText(v)
  return one ? [one] : []
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '')
  return out
}

function metaContent(html: string, key: string): string | null {
  const wanted = key.toLowerCase()
  const re = /<meta\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = parseAttrs(m[0])
    const name = (attrs.property ?? attrs.name ?? '').toLowerCase()
    if (name === wanted && attrs.content) return attrs.content
  }
  return null
}

/** 从 startIndex 处的 <div ...> 开始，按 div 配对找到整段 */
function extractBalancedDiv(html: string, startIndex: number): string | null {
  const tagRe = /<\/?div\b[^>]*>/gi
  tagRe.lastIndex = startIndex
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    if (m[0][1] === '/') depth -= 1
    else depth += 1
    if (depth === 0) return html.slice(startIndex, m.index)
  }
  return null
}

/** 找第一个带指定属性的 div（比如 id="info"）并返回整段 */
function divByAttr(html: string, attr: string): string | null {
  const openRe = /<div\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = openRe.exec(html))) {
    if (m[0].includes(attr)) return extractBalancedDiv(html, m.index)
  }
  return null
}

function looksLikeIsbn(raw: string): boolean {
  const compact = raw.replace(/[-\s]/g, '')
  return /^(97[89]\d{10}|\d{9}[\dXx])$/.test(compact)
}

function isbnOf(raw: string): string {
  return raw.replace(/[-\s]/g, '').toUpperCase()
}

/* ------------------------------------------------------------------ */
/* 图片尺寸：自己读文件头                                               */
/* ------------------------------------------------------------------ */

interface ImageSize {
  width: number
  height: number
}

function imageExt(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png'
  const sig6 = buf.length >= 6 ? buf.toString('ascii', 0, 6) : ''
  if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp'
  }
  return null
}

/** JPEG：顺着 marker 走到 SOFn，宽高在那一段里（EXIF 缩略图也是 SOFn，靠段长跳过） */
function jpegSize(buf: Buffer): ImageSize | null {
  let i = 2
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1
      continue
    }
    let marker = buf[i + 1]
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1
      marker = buf[i + 1]
    }
    i += 2 // 现在指向长度字段
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    // 到 SOS 或者文件结束还没见到 SOFn，说明读不出来
    if (marker === 0xd9 || marker === 0xda) return null
    if (i + 1 >= buf.length) return null
    const len = buf.readUInt16BE(i)
    if (len < 2) return null
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 6 >= buf.length) return null
      return { height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) }
    }
    i += len
  }
  return null
}

function imageSize(buf: Buffer): ImageSize | null {
  if (buf.length < 16) return null
  const ext = imageExt(buf)
  if (ext === 'jpg') return jpegSize(buf)
  if (ext === 'png') {
    if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (ext === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (ext === 'webp') {
    // 12 字节容器头 + 4 字节块类型 + 4 字节块长度，数据从第 20 字节开始
    if (buf.length < 25) return null
    const kind = buf.toString('ascii', 12, 16)
    const p = 20
    if (kind === 'VP8 ') {
      if (buf.length < p + 10) return null
      if (buf[p + 3] !== 0x9d || buf[p + 4] !== 0x01 || buf[p + 5] !== 0x2a) return null
      return {
        width: buf.readUInt16LE(p + 6) & 0x3fff,
        height: buf.readUInt16LE(p + 8) & 0x3fff
      }
    }
    if (kind === 'VP8L') {
      if (buf.length < p + 5 || buf[p] !== 0x2f) return null
      const b1 = buf[p + 1]
      const b2 = buf[p + 2]
      const b3 = buf[p + 3]
      const b4 = buf[p + 4]
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
      }
    }
    if (kind === 'VP8X') {
      if (buf.length < p + 10) return null
      return {
        width: 1 + (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16)),
        height: 1 + (buf[p + 7] | (buf[p + 8] << 8) | (buf[p + 9] << 16))
      }
    }
    return null
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 封面：候选地址 / 下载 / 探测尺寸                                     */
/* ------------------------------------------------------------------ */

interface CoverInfo {
  url: string
  width: number | null
  height: number | null
  bytes: number
}

const coverCache = new Map<string, { at: number; info: CoverInfo }>()

function httpsify(raw: string): string {
  const url = raw.trim()
  if (url.startsWith('//')) return `https:${url}`
  return url
}

/** 豆瓣的 /s/ 是小图、/l/ 是大图，优先大图，失败再回小图 */
function coverCandidates(url: string): string[] {
  const out: string[] = []
  if (/\/view\/subject\/[sm]\/public\//.test(url)) {
    out.push(url.replace(/\/view\/subject\/[sm]\/public\//, '/view/subject/l/public/'))
  }
  out.push(url)
  return [...new Set(out)]
}

type ImageResult = { ok: true; buf: Buffer; ext: string } | { ok: false; error: string }

async function fetchImage(url: string, maxBytes: number): Promise<ImageResult> {
  try {
    const res = await net.fetch(url, {
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: { 'User-Agent': UA, ...imageHeaders(url) }
    })
    if (!res.ok) return { ok: false, error: httpError(res.status) }
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > maxBytes) return { ok: false, error: `图片太大（${humanSize(declared)}）` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return { ok: false, error: '图片是空的' }
    if (buf.length > maxBytes) return { ok: false, error: `图片太大（${humanSize(buf.length)}）` }
    const ext = imageExt(buf)
    if (!ext) return { ok: false, error: '不是常见图片格式' }
    return { ok: true, buf, ext }
  } catch (e) {
    return { ok: false, error: netError(e, url) }
  }
}

/** 下载封面并量出真实像素；全都拿不到时保留地址、宽高为 null */
async function probeCover(rawUrl: string | null): Promise<CoverInfo | null> {
  if (!rawUrl) return null
  const url = httpsify(rawUrl)
  if (!/^https?:\/\//i.test(url)) return null
  const hit = coverCache.get(url)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info

  let unknown: CoverInfo | null = null
  for (const candidate of coverCandidates(url)) {
    const img = await fetchImage(candidate, IMAGE_MAX_BYTES)
    if (!img.ok) continue
    const dim = imageSize(img.buf)
    const info: CoverInfo = {
      url: candidate,
      width: dim?.width ?? null,
      height: dim?.height ?? null,
      bytes: img.buf.length
    }
    if (dim) {
      coverCache.set(url, { at: Date.now(), info })
      return info
    }
    unknown ??= info
  }

  const info = unknown ?? { url, width: null, height: null, bytes: 0 }
  coverCache.set(url, { at: Date.now(), info })
  return info
}

async function attachCover(hit: WebMetaHit): Promise<void> {
  const info = await probeCover(hit.coverUrl)
  if (!info) return
  hit.coverUrl = info.url
  hit.coverWidth = info.width
  hit.coverHeight = info.height
}

async function attachCovers(hits: WebMetaHit[]): Promise<void> {
  await mapLimit(hits, COVER_CONCURRENCY, async (hit) => {
    try {
      await attachCover(hit)
    } catch {
      /* 单张封面探测失败就留 null，不影响整页 */
    }
    return null
  })
}

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
/* 豆瓣                                                                */
/* ------------------------------------------------------------------ */

interface DoubanSuggestion {
  id: string
  title: string
  author: string
  year: string
  pic: string
}

function parseSuggest(text: string): DoubanSuggestion[] {
  try {
    const data: unknown = JSON.parse(text)
    if (!Array.isArray(data)) return []
    const out: DoubanSuggestion[] = []
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      // type=b 才是书；a 是作者、m 是电影
      if (row.type !== 'b') continue
      const id = asText(row.id)
      if (!id) continue
      out.push({
        id,
        title: asText(row.title),
        author: asText(row.author_name),
        year: asText(row.year),
        pic: asText(row.pic)
      })
    }
    return out
  } catch {
    return []
  }
}

function subjectIdOf(url: string): string | null {
  const m = /\/subject\/(\d+)/.exec(url)
  return m ? m[1] : null
}

function doubanSummary(html: string): string {
  const report = divByAttr(html, 'id="link-report"')
  if (!report) return ''
  const intro = divByAttr(report, 'class="intro"') ?? report
  let text = htmlToText(intro)
  if (text.length > 4000) text = `${text.slice(0, 4000).trimEnd()}…`
  return text
}

function doubanCover(html: string): string | null {
  const og = metaContent(html, 'og:image')
  if (og) return httpsify(og)
  const mainpic = divByAttr(html, 'id="mainpic"')
  if (!mainpic) return null
  const a = /<a\b[^>]*\bhref=["']([^"']+)["']/i.exec(mainpic)
  if (a) return httpsify(a[1])
  const img = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(mainpic)
  return img ? httpsify(img[1]) : null
}

function doubanRating(html: string): number | null {
  const m =
    /property=["']v:average["'][^>]*>\s*([\d.]+)/i.exec(html) ??
    /class=["'][^"']*rating_num[^"']*["'][^>]*>\s*([\d.]+)/i.exec(html)
  if (!m) return null
  const n = Number.parseFloat(m[1])
  return Number.isFinite(n) && n > 0 && n <= 10 ? n : null
}

/** 把 #info 里的「标签: 值」行拆成 map（作者、译者、出版社、出版年、ISBN…） */
function doubanInfoMap(infoHtml: string): Record<string, string> {
  const text = htmlToText(infoHtml)
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^([^\s:：]{1,10})\s*[:：]\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2].trim()
    if (!key || !value || key in out) continue
    out[key] = value
  }
  return out
}

function doubanHitFromHtml(
  html: string,
  id: string,
  finalUrl: string,
  fallback: { title?: string; author?: string; year?: string; cover?: string | null } = {}
): WebMetaHit | null {
  const isBookPage =
    /property=["']v:itemreviewed["']/i.test(html) && (metaContent(html, 'og:type') ?? 'book') === 'book'
  if (!isBookPage) return null

  const info = doubanInfoMap(divByAttr(html, 'id="info"') ?? '')
  const title =
    cleanInline((/<span[^>]*property=["']v:itemreviewed["'][^>]*>([\s\S]*?)<\/span>/i.exec(html) ?? [])[1] ?? '') ||
    fallback.title ||
    cleanInline((/<title>([\s\S]*?)<\/title>/i.exec(html) ?? [])[1] ?? '').replace(/\s*\(豆瓣\)\s*$/, '') ||
    '未命名'

  const realId = subjectIdOf(finalUrl) ?? id
  const url = subjectIdOf(finalUrl) ? finalUrl : `${DOUBAN_HOST}/subject/${id}/`
  const cover = doubanCover(html) ?? fallback.cover ?? null

  return {
    source: 'douban',
    sourceName: '豆瓣',
    id: realId,
    title,
    authors: cleanInline(info['作者'] ?? fallback.author ?? ''),
    publisher: cleanInline(info['出版社'] ?? ''),
    pubdate: cleanInline(info['出版年'] ?? fallback.year ?? ''),
    isbn: (info['ISBN'] ?? '').replace(/[^0-9Xx]/g, '').toUpperCase(),
    // 豆瓣不标语言
    language: '',
    rating: doubanRating(html),
    summary: doubanSummary(html),
    coverUrl: cover,
    coverWidth: null,
    coverHeight: null,
    url
  }
}

/** 抓豆瓣 subject 页（或 isbn 跳转页），失败返回 null */
async function doubanDetailRaw(idOrIsbn: string): Promise<WebMetaHit | null> {
  const raw = idOrIsbn.trim()
  if (!raw) return null
  const isIsbn = looksLikeIsbn(raw)
  const target = isIsbn
    ? `${DOUBAN_HOST}/isbn/${encodeURIComponent(isbnOf(raw))}/`
    : `${DOUBAN_HOST}/subject/${encodeURIComponent(raw)}/`

  await doubanGate()
  const res = await fetchText(target, doubanHeaders())
  if (!res.ok) return null
  // Electron 的 net.fetch 不返回重定向后的 URL（res.url 是空的），
  // 所以 subject id 从页面里的 og:url 拿，isbn 跳转页也能落到正确的书。
  const realId =
    subjectIdOf(metaContent(res.text, 'og:url') ?? '') ??
    subjectIdOf(res.url) ??
    (isIsbn ? null : raw)
  if (!realId) return null
  return doubanHitFromHtml(res.text, realId, `${DOUBAN_HOST}/subject/${realId}/`)
}

const douban = {
  id: 'douban',
  name: '豆瓣',
  async search(query: string): Promise<WebMetaHit[]> {
    const q = query.trim()
    if (!q) return []

    // ISBN 直接走 isbn 跳转，比关键词准
    if (looksLikeIsbn(q)) {
      const hit = await doubanDetailRaw(q)
      if (hit) {
        await attachCover(hit)
        return [hit]
      }
    }

    await doubanGate()
    const res = await fetchText(
      `${DOUBAN_HOST}/j/subject_suggest?q=${encodeURIComponent(q)}`,
      doubanHeaders('application/json, text/javascript, */*; q=0.01')
    )
    if (!res.ok) return []
    const suggestions = parseSuggest(res.text).slice(0, DOUBAN_MAX_HITS)
    if (!suggestions.length) return []

    const hits: WebMetaHit[] = suggestions.slice(0, DOUBAN_ENRICH).map((s) => ({
      source: 'douban',
      sourceName: '豆瓣',
      id: s.id,
      title: s.title || '未命名',
      authors: s.author,
      publisher: '',
      pubdate: s.year,
      isbn: '',
      language: '',
      rating: null,
      summary: '',
      coverUrl: s.pic || null,
      coverWidth: null,
      coverHeight: null,
      url: `${DOUBAN_HOST}/subject/${s.id}/`
    }))

    // 建议接口只有书名/作者/年份，逐本补详情。串行 + 限速，单本失败就保留建议里的信息。
    for (const hit of hits) {
      const fallbackCover = hit.coverUrl
      try {
        const detail = await doubanDetailRaw(hit.id)
        if (detail) {
          Object.assign(hit, detail)
          if (!hit.coverUrl && fallbackCover) hit.coverUrl = fallbackCover
        }
      } catch {
        /* 忽略单本失败 */
      }
    }

    await attachCovers(hits)
    return hits
  },
  async detail(id: string): Promise<WebMetaHit | null> {
    try {
      const hit = await doubanDetailRaw(id)
      if (!hit) return null
      await attachCover(hit)
      return hit
    } catch {
      return null
    }
  }
}

/* ------------------------------------------------------------------ */
/* NeoDB                                                               */
/* ------------------------------------------------------------------ */

interface NeodbRow {
  [key: string]: unknown
}

function neodbHit(raw: unknown): WebMetaHit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as NeodbRow
  const uuid = asText(row.uuid)
  const absId = asText(row.id) || (uuid ? `${NEODB_HOST}/book/${uuid}` : '')
  const relUrl = asText(row.url) || (uuid ? `/book/${uuid}` : '')
  if (!absId && !relUrl) return null

  const year = asText(row.pub_year)
  const monthRaw = asText(row.pub_month)
  const month = monthRaw ? monthRaw.padStart(2, '0') : ''
  const pubdate = asText(row.pub_date) || (year ? `${year}${month ? `-${month}` : ''}` : '')

  return {
    source: 'neodb',
    sourceName: 'NeoDB',
    id: absId || `${NEODB_HOST}${relUrl}`,
    title: asText(row.title) || asText(row.display_title) || '未命名',
    authors: asTextArray(row.author).join(' / '),
    publisher: asTextArray(row.publisher).join(' / '),
    pubdate,
    isbn: asText(row.isbn).replace(/[^0-9Xx]/g, '').toUpperCase(),
    language: asTextArray(row.language).join(','),
    rating: asNumber(row.rating),
    summary: neodbSummary(asText(row.description)),
    coverUrl: asText(row.cover_image_url) || null,
    coverWidth: null,
    coverHeight: null,
    url: /^https?:\/\//i.test(relUrl) ? relUrl : `${NEODB_HOST}${relUrl.startsWith('/') ? '' : '/'}${relUrl}`
  }
}

/** NeoDB 的 description 多数是纯文本，偶尔带 HTML，转一次就好 */
function neodbSummary(raw: string): string {
  if (!raw) return ''
  const text = /<[a-z][^>]*>/i.test(raw) ? htmlToText(raw) : decodeEntities(raw)
  const tidy = text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return tidy.length > 4000 ? `${tidy.slice(0, 4000).trimEnd()}…` : tidy
}

function neodbApiUrl(id: string): string | null {
  const raw = id.trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) {
    try {
      const path = new URL(raw).pathname.replace(/\/+$/, '')
      return path ? `${NEODB_HOST}/api${path}` : null
    } catch {
      return null
    }
  }
  if (raw.startsWith('/')) return `${NEODB_HOST}/api${raw.replace(/\/+$/, '')}`
  return `${NEODB_HOST}/api/book/${encodeURIComponent(raw)}`
}

function parseJsonObject(text: string): NeodbRow | null {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as NeodbRow
  } catch {
    return null
  }
}

const neodb = {
  id: 'neodb',
  name: 'NeoDB',
  async search(query: string): Promise<WebMetaHit[]> {
    const q = query.trim()
    if (!q) return []
    const url = `${NEODB_HOST}/api/catalog/search?query=${encodeURIComponent(q)}&category=book`
    const res = await fetchText(url, neodbHeaders())
    if (!res.ok) return []
    const body = parseJsonObject(res.text)
    const rows = Array.isArray(body?.data) ? (body?.data as unknown[]) : []
    const hits: WebMetaHit[] = []
    for (const row of rows.slice(0, NEODB_MAX_HITS)) {
      const hit = neodbHit(row)
      if (hit) hits.push(hit)
    }
    await attachCovers(hits)
    return hits
  },
  async detail(id: string): Promise<WebMetaHit | null> {
    try {
      const api = neodbApiUrl(id)
      if (!api) return null
      const res = await fetchText(api, neodbHeaders())
      if (!res.ok) return null
      const hit = neodbHit(parseJsonObject(res.text))
      if (!hit) return null
      await attachCover(hit)
      return hit
    } catch {
      return null
    }
  }
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

const ADAPTERS = [douban, neodb] as const

function webSettings(): WebMetaSettings {
  const web = ctx.settings?.get().web
  if (web && Array.isArray(web.sources)) {
    const min = Number(web.minCoverWidth)
    return { sources: web.sources.map((s) => String(s)), minCoverWidth: Number.isFinite(min) ? min : 0 }
  }
  return { sources: ['douban', 'neodb'], minCoverWidth: 200 }
}

/** 按设置里启用的源并发搜索；某个源挂了就当它没结果 */
async function metaSearch(query: string): Promise<WebMetaHit[]> {
  const q = String(query ?? '').trim()
  if (!q) return []
  const enabled = webSettings().sources
  const active = ADAPTERS.filter((a) => enabled.includes(a.id))
  if (!active.length) return []
  const settled = await Promise.allSettled(active.map((a) => a.search(q)))
  const out: WebMetaHit[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) out.push(...result.value)
  }
  return out
}

async function metaDetail(source: string, id: string): Promise<WebMetaHit | null> {
  const adapter = ADAPTERS.find((a) => a.id === source)
  if (!adapter || !id) return null
  try {
    return await adapter.detail(id)
  } catch {
    return null
  }
}

/** 只要带封面、且宽度达到设置下限的，按像素面积从大到小 */
async function coverSearch(query: string): Promise<WebMetaHit[]> {
  const hits = await metaSearch(query)
  const min = webSettings().minCoverWidth
  return hits
    .filter(
      (h) =>
        Boolean(h.coverUrl) &&
        h.coverWidth !== null &&
        h.coverHeight !== null &&
        h.coverWidth >= min &&
        h.coverHeight > 0
    )
    .sort(
      (a, b) =>
        (b.coverWidth ?? 0) * (b.coverHeight ?? 0) - (a.coverWidth ?? 0) * (a.coverHeight ?? 0)
    )
}

/* ------------------------------------------------------------------ */
/* 换封面                                                              */
/* ------------------------------------------------------------------ */

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

async function coverApplyUrl(
  bookId: number,
  url: string
): Promise<{ ok: boolean; message: string }> {
  const fail = (message: string): { ok: false; message: string } => ({ ok: false, message })

  const id = Number(bookId)
  if (!Number.isFinite(id) || id <= 0) return fail('书 id 不对')
  const src = httpsify(String(url ?? ''))
  if (!/^https?:\/\//i.test(src)) return fail('封面地址无效')

  const lib = ctx.ensureLibrary()
  if (!lib?.isReady) return fail('书库还没就绪，先到设置里选书库路径')
  const book = lib.book(id)
  if (!book) return fail('书库里找不到这本书')

  // calibre 主程序开着时 calibredb 会拒绝写入
  if (await isCalibreRunning()) return fail('calibre 正在运行，先关掉 calibre 再换封面')
  ctx.calibreRunning = false

  const img = await fetchImage(src, APPLY_MAX_BYTES)
  if (!img.ok) return fail(`下载封面失败：${img.error}`)
  const dim = imageSize(img.buf)
  if (!dim) return fail('下载到的不是能识别的图片（JPEG / PNG / WebP / GIF）')

  const dir = join(app.getPath('userData'), 'downloads')
  const file = join(dir, `cover-${id}-${Date.now()}.${img.ext}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, img.buf)
  } catch (e) {
    return fail(`写临时文件失败：${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    if (await isCalibreRunning()) {
      return fail(`《${book.title}》的封面下载好了，但 calibre 正在运行，没换成。关掉 calibre 再试。`)
    }
    await run(
      calibreExe('calibredb'),
      ['set_metadata', String(id), '--field', `cover:${file}`, '--with-library', lib.root],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    )
  } catch (e) {
    return fail(`《${book.title}》封面没换成：${calibredbFailure(e)}`)
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* 临时文件删不掉不影响结果 */
    }
  }

  ctx.reload()
  return {
    ok: true,
    message: `《${book.title}》封面已更新（${dim.width}×${dim.height}，${humanSize(img.buf.length)}）`
  }
}

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

export function registerMeta(): void {
  ipcMain.handle(CH.metaSearch, async (_e, query: string) => {
    try {
      return await metaSearch(query)
    } catch {
      return []
    }
  })

  ipcMain.handle(CH.metaDetail, async (_e, source: string, id: string) => {
    try {
      return await metaDetail(String(source ?? ''), String(id ?? ''))
    } catch {
      return null
    }
  })

  ipcMain.handle(CH.coverSearch, async (_e, query: string) => {
    try {
      return await coverSearch(query)
    } catch {
      return []
    }
  })

  ipcMain.handle(CH.coverApplyUrl, async (_e, bookId: number, url: string) => {
    try {
      return await coverApplyUrl(Number(bookId), String(url ?? ''))
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '换封面失败' }
    }
  })
}
