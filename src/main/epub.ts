/**
 * 内置阅读器的 EPUB 解包与资源服务。
 *
 * 三条约束定下了这里的写法：
 *  1. 不引依赖 —— zip 自己解析：EOCD → 中央目录 → local file header，
 *     只支持 stored(0) 与 deflate(8)，这两种覆盖了实际见到的所有 EPUB。
 *  2. 章节用 `epubres://<bookId>/<包内路径>` 装进 iframe。iframe 的源是
 *     `epubres://<id>`，和渲染进程的 file:// 不同源，父页面拿不到
 *     contentWindow.document，所以阅读样式与一小段脚本由主进程在返回 HTML 时注入，
 *     字号/主题/滚动位置全部走 postMessage 往返。
 *  3. 阅读进度写本应用自己的 reading-progress.json，不碰 calibre 的库文件
 *     （calibre 跑着的时候 metadata.db 是被锁死的）。
 */
import { app, ipcMain, protocol } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { CH } from '../shared/ipc'
import type { ReaderInfo, ReaderSpineItem } from '../shared/types'
import { ctx } from './ctx'
import { writeFileAtomic } from './file-utils'

/* ============================ ZIP ============================ */

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const ZIP64_LOC_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50

interface ZipEntry {
  name: string
  flags: number
  method: number
  compSize: number
  size: number
  localOffset: number
}

interface ZipArchive {
  file: string
  mtimeMs: number
  size: number
  buffer: Buffer
  entries: Map<string, ZipEntry>
  lower: Map<string, ZipEntry>
  /** 已经处理过的章节 HTML（注入过样式），避免每次翻页重算 */
  pageCache: Map<string, string>
  /** 解出来的原始字节，图片/CSS 复用 */
  byteCache: Map<string, Buffer>
  cachedBytes: number
  /** 解析过的 OPF（manifest / spine），给 readerInfo 和协议处理共用 */
  pkg: ParsedPackage | null
}

const archiveCache = new Map<string, ZipArchive>()
/** 同时最多留几本解压后的缓冲区；翻别的书时旧的自动丢掉，避免几十 MB × N */
const ARCHIVE_LIMIT = 3
/** 单本最多缓存多少字节的解压结果，超过就只留章节 HTML */
const BYTE_CACHE_LIMIT = 48 * 1024 * 1024

/** 去掉 . / .. 和多余的分隔符，统一成正斜杠 */
function normalizePath(p: string): string {
  const out: string[] = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function findEocd(buf: Buffer): number {
  // 注释最长 65535，EOCD 至少 22 字节
  const stop = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** 解码条目名。EPUB 规范要求 UTF-8（标志位 11），但老书里有按 GBK 写还不打标志的 */
function decodeName(raw: Buffer): string {
  let name = raw.toString('utf8')
  if (name.includes('\uFFFD')) {
    try {
      name = new TextDecoder('gb18030', { fatal: true }).decode(raw)
    } catch {
      /* 保持 utf8 的替换字符结果 */
    }
  }
  return normalizePath(name)
}

/** 从 zip64 扩展字段里补出真正的长度/偏移 */
function readZip64(extra: Buffer, size: number, compSize: number, localOffset: number): {
  size: number
  compSize: number
  localOffset: number
} {
  let needSize = size === 0xffffffff
  let needComp = compSize === 0xffffffff
  let needOffset = localOffset === 0xffffffff
  let out = { size, compSize, localOffset }
  let p = 0
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p)
    const len = extra.readUInt16LE(p + 2)
    if (p + 4 + len > extra.length) break
    if (id === 0x0001) {
      let q = p + 4
      if (needSize && q + 8 <= p + 4 + len) {
        out = { ...out, size: Number(extra.readBigUInt64LE(q)) }
        q += 8
        needSize = false
      }
      if (needComp && q + 8 <= p + 4 + len) {
        out = { ...out, compSize: Number(extra.readBigUInt64LE(q)) }
        q += 8
        needComp = false
      }
      if (needOffset && q + 8 <= p + 4 + len) {
        out = { ...out, localOffset: Number(extra.readBigUInt64LE(q)) }
        needOffset = false
      }
      break
    }
    p += 4 + len
  }
  return out
}

function parseCentralDirectory(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('找不到 zip 中央目录（这个文件可能不是 epub）')

  let count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)

  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20
    if (loc >= 0 && buf.readUInt32LE(loc) === ZIP64_LOC_SIG) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8))
      if (z64 > 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
        count = Number(buf.readBigUInt64LE(z64 + 32))
        offset = Number(buf.readBigUInt64LE(z64 + 48))
      }
    }
  }
  if (offset <= 0 || offset >= buf.length) throw new Error('zip 中央目录位置不对')

  const entries = new Map<string, ZipEntry>()
  let p = offset
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const rawComp = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const rawOffset = buf.readUInt32LE(p + 42)
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen))
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    const filled =
      rawComp === 0xffffffff || rawSize === 0xffffffff || rawOffset === 0xffffffff
        ? readZip64(extra, rawSize, rawComp, rawOffset)
        : { size: rawSize, compSize: rawComp, localOffset: rawOffset }

    if (name) {
      entries.set(name, {
        name,
        flags,
        method,
        compSize: filled.compSize,
        size: filled.size,
        localOffset: filled.localOffset
      })
    }
    p += 46 + nameLen + extraLen + commentLen
  }

  if (entries.size === 0) throw new Error('zip 里没有可用的条目')
  return entries
}

/**
 * 取一个条目的字节。大小以中央目录为准：bit 3（data descriptor）打开时，
 * local header 里的长度字段是 0，只有中央目录靠得住。
 */
function extractEntry(archive: ZipArchive, entry: ZipEntry): Buffer {
  const cached = archive.byteCache.get(entry.name)
  if (cached) return cached

  const buf = archive.buffer
  const p = entry.localOffset
  if (p < 0 || p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) {
    throw new Error(`zip 条目损坏：${entry.name}`)
  }
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const end = start + entry.compSize
  if (start >= buf.length || end > buf.length) throw new Error(`zip 条目被截断：${entry.name}`)
  const raw = buf.subarray(start, end)

  let data: Buffer
  if (entry.method === 0) data = raw
  else if (entry.method === 8) data = inflateRawSync(raw)
  else throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`)

  if (data.length <= 8 * 1024 * 1024 && archive.cachedBytes + data.length <= BYTE_CACHE_LIMIT) {
    archive.byteCache.set(entry.name, data)
    archive.cachedBytes += data.length
  }
  return data
}

function openArchive(file: string): ZipArchive {
  const stat = statSync(file)
  const hit = archiveCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    // 重新插到队尾，让它成为「最近用的」
    archiveCache.delete(file)
    archiveCache.set(file, hit)
    return hit
  }

  const buffer = readFileSync(file)
  const entries = parseCentralDirectory(buffer)
  const lower = new Map<string, ZipEntry>()
  for (const [name, entry] of entries) lower.set(name.toLowerCase(), entry)
  const archive: ZipArchive = {
    file,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    buffer,
    entries,
    lower,
    pageCache: new Map(),
    byteCache: new Map(),
    cachedBytes: 0,
    pkg: null
  }
  archiveCache.delete(file)
  archiveCache.set(file, archive)
  while (archiveCache.size > ARCHIVE_LIMIT) {
    const oldest = archiveCache.keys().next().value
    if (oldest === undefined) break
    archiveCache.delete(oldest)
  }
  return archive
}

function findEntry(archive: ZipArchive, name: string): ZipEntry | null {
  const key = normalizePath(name)
  return archive.entries.get(key) ?? archive.lower.get(key.toLowerCase()) ?? null
}

/* ============================ 文本 ============================ */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  '#39': "'"
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]|#39);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '')
  }
  return out
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 把包内相对路径解析成「相对包根」的完整路径 */
function resolveHref(baseDir: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0].trim()
  if (!clean) return ''
  const decoded = safeDecode(clean)
  const stack = decoded.startsWith('/') ? [] : baseDir.split('/').filter(Boolean)
  for (const seg of decoded.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join('/')
}

/** 包内路径 → URL 路径。逐段编码，斜杠保留 */
function encodePath(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/** 按声明 / BOM / 回退猜编码，统一解成 JS 字符串（之后一律按 UTF-8 输出） */
function decodeText(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8')
  }
  const head = bytes.subarray(0, 2048).toString('latin1')
  const declared =
    /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    ''
  const labels = [declared, 'utf-8', 'gb18030'].filter((x) => x.length > 0)
  for (const label of labels) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes)
    } catch {
      /* 试下一个 */
    }
  }
  return bytes.toString('utf8')
}

function readBytes(archive: ZipArchive, name: string): Buffer | null {
  const entry = findEntry(archive, name)
  if (!entry) return null
  try {
    return extractEntry(archive, entry)
  } catch {
    return null
  }
}

function readText(archive: ZipArchive, name: string): string | null {
  const bytes = readBytes(archive, name)
  return bytes ? decodeText(bytes) : null
}

/* ============================ EPUB 结构 ============================ */

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

interface TocItem {
  href: string
  label: string
}

const HTML_TYPES = /^(application\/xhtml\+xml|text\/html|application\/xml)$/i
const HTML_EXT = /\.(x?html?|xht)$/i

function parseContainer(xml: string): string {
  const m = /<rootfile\b([^>]*)>/i.exec(xml)
  if (!m) throw new Error('META-INF/container.xml 里没有 rootfile')
  const path = parseAttrs(m[1])['full-path']
  if (!path) throw new Error('container.xml 的 rootfile 缺少 full-path')
  return safeDecode(path)
}

function parseOpf(opfPath: string, xml: string): {
  title: string
  authors: string
  manifest: Map<string, ManifestItem>
  spine: string[]
  tocId: string
  coverPath: string
} {
  const dir = dirOf(opfPath)
  const manifest = new Map<string, ManifestItem>()
  const itemRe = /<item\b([^>]*?)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml))) {
    const attrs = parseAttrs(m[1])
    const id = attrs.id
    const href = attrs.href
    if (!id || !href) continue
    manifest.set(id, {
      id,
      href: resolveHref(dir, href),
      mediaType: (attrs['media-type'] ?? '').toLowerCase(),
      properties: (attrs.properties ?? '').toLowerCase()
    })
  }

  const spineAttrs = parseAttrs(/<spine\b([^>]*)>/i.exec(xml)?.[1] ?? '')
  const spine: string[] = []
  const refRe = /<itemref\b([^>]*?)\/?>/gi
  while ((m = refRe.exec(xml))) {
    const idref = parseAttrs(m[1]).idref
    if (idref && manifest.has(idref)) spine.push(idref)
  }

  const titles = [...xml.matchAll(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/gi)]
  const creators = [...xml.matchAll(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/gi)]
  const title = stripTags(titles[0]?.[1] ?? '')
  const authorList = creators.map((c) => stripTags(c[1])).filter(Boolean)

  // 封面页在目录里通常没有标题，兜底给它一个「封面」
  const guideCover = [...xml.matchAll(/<reference\b([^>]*?)\/?>/gi)]
    .map((m) => parseAttrs(m[1]))
    .find((a) => (a.type ?? '').toLowerCase() === 'cover' && a.href)
  const metaCover = /<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(xml)?.[0]
  const coverId = metaCover ? parseAttrs(metaCover).content ?? '' : ''
  const propsCover = [...manifest.values()].find((i) => i.properties.includes('cover-image'))
  const coverPath =
    (guideCover ? resolveHref(dir, guideCover.href) : '') ||
    (coverId ? manifest.get(coverId)?.href ?? '' : '') ||
    propsCover?.href ||
    ''

  return { title, authors: authorList.join(' & '), manifest, spine, tocId: spineAttrs.toc ?? '', coverPath }
}

function parseNcx(xml: string, baseDir: string): TocItem[] {
  const navMap = /<navMap\b[^>]*>([\s\S]*?)<\/navMap>/i.exec(xml)?.[1] ?? ''
  const out: TocItem[] = []
  let label = ''
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>|<content\b([^>]*?)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(navMap))) {
    if (m[1] !== undefined) {
      label = stripTags(m[1])
      continue
    }
    const src = parseAttrs(m[2] ?? '').src
    if (!src) continue
    const href = resolveHref(baseDir, src)
    if (href) out.push({ href, label })
    label = ''
  }
  return out
}

function parseNav(xml: string, baseDir: string): TocItem[] {
  const navs = [...xml.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)]
  if (navs.length === 0) return []
  const toc =
    navs.find((n) => /toc/i.test(parseAttrs(n[1])['epub:type'] ?? parseAttrs(n[1])['type'] ?? '')) ??
    navs[0]
  const out: TocItem[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(toc[2]))) {
    const href = resolveHref(baseDir, parseAttrs(m[1]).href ?? '')
    const label = stripTags(m[2])
    if (href) out.push({ href, label })
  }
  return out
}

/** 章节自己没被目录点到时，从正文里捞个标题（限次数，别把整本书都解压一遍） */
function guessLabel(archive: ZipArchive, path: string): string {
  const text = readText(archive, path)
  if (!text) return ''
  const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(text)?.[1]
  if (heading) {
    const label = stripTags(heading)
    if (label) return label.slice(0, 60)
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]
  return title ? stripTags(title).slice(0, 60) : ''
}

interface ParsedPackage {
  opfPath: string
  title: string
  authors: string
  manifest: Map<string, ManifestItem>
  spine: string[]
  tocId: string
  /** 封面页（guide / meta cover / cover-image 三种写法里认出来的那个） */
  coverPath: string
  /** 小写包内路径 -> manifest 的 media-type。没有扩展名的章节文件全靠它认类型 */
  mediaTypes: Map<string, string>
}

/** container.xml → OPF → manifest/spine。按 archive 缓存一次，协议处理和目录共用 */
function packageOf(archive: ZipArchive): ParsedPackage {
  if (archive.pkg) return archive.pkg
  const containerXml = readText(archive, 'META-INF/container.xml')
  if (!containerXml) throw new Error('缺少 META-INF/container.xml')
  const opfPath = parseContainer(containerXml)
  const opfXml = readText(archive, opfPath)
  if (!opfXml) throw new Error(`找不到 OPF：${opfPath}`)
  const opf = parseOpf(opfPath, opfXml)
  const mediaTypes = new Map<string, string>()
  for (const item of opf.manifest.values()) {
    if (item.mediaType) mediaTypes.set(item.href.toLowerCase(), item.mediaType)
  }
  archive.pkg = { opfPath, ...opf, mediaTypes }
  return archive.pkg
}

/* ============================ 阅读样式（注入 iframe） ============================ */

const READER_CSS = `
:root{color-scheme:light}
html{--rd-fs:19px;--rd-lh:1.85;--rd-fg:#1f1f1f;--rd-bg:#ffffff;--rd-link:#0a8f4d;--rd-soft:#6f6f6f;--rd-line:#e8e8e8;background:var(--rd-bg)}
html[data-rd-theme='paper']{--rd-fg:#3b3327;--rd-bg:#f6f0e2;--rd-link:#0a7a43;--rd-soft:#7a7060;--rd-line:#e3dac6;color-scheme:light}
html[data-rd-theme='dark']{--rd-fg:#c9c9c9;--rd-bg:#161616;--rd-link:#4ecb83;--rd-soft:#8d8d8d;--rd-line:#2b2b2b;color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--rd-bg)!important}
body{background:var(--rd-bg)!important;color:var(--rd-fg)!important;font-family:'Microsoft YaHei UI','Microsoft YaHei','PingFang SC','Hiragino Sans GB',system-ui,sans-serif!important;font-size:var(--rd-fs)!important;line-height:var(--rd-lh)!important;max-width:760px;margin:0 auto!important;padding:44px 36px 34vh!important;min-height:0!important;overflow-wrap:break-word;word-wrap:break-word;-webkit-font-smoothing:antialiased}
html[data-rd-theme='paper'] body *{background-color:transparent!important}
html[data-rd-theme='dark'] body *{background-color:transparent!important;color:inherit!important}
html[data-rd-theme='dark'] body a{color:var(--rd-link)!important}
html[data-rd-theme='dark'] body blockquote{color:var(--rd-soft)!important}
p,ul,ol,dl,blockquote,pre,table,figure{margin:0 0 0.72em!important}
p{min-height:1em}
h1,h2,h3,h4,h5,h6{line-height:1.45!important;margin:1.4em 0 0.7em!important;font-weight:600!important;text-indent:0!important}
h1{font-size:1.6em}h2{font-size:1.35em}h3{font-size:1.18em}
img,video,object,embed{max-width:100%!important;height:auto!important}
img{break-inside:avoid}
a{color:var(--rd-link)!important;text-decoration:none!important}
a:hover{text-decoration:underline!important}
blockquote{margin:1.1em 0!important;padding:0 0 0 1em!important;border-left:3px solid var(--rd-line);color:var(--rd-soft)!important}
pre,code,kbd{font-family:'Cascadia Mono',Consolas,monospace!important;font-size:0.9em!important}
pre{white-space:pre-wrap}
hr{border:0;border-top:1px solid var(--rd-line);margin:1.8em 0!important}
table{width:auto;max-width:100%;border-collapse:collapse}
td,th{padding:4px 8px;border:1px solid var(--rd-line)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border:2px solid transparent;border-radius:6px;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.3);background-clip:content-box}
html[data-rd-theme='dark']::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);background-clip:content-box}
html[data-rd-theme='dark']::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.34);background-clip:content-box}
::selection{background:rgba(7,193,96,.24)}
`

const READER_JS = `
(function () {
  'use strict'
  var root = document.documentElement
  var params = new URLSearchParams(location.search)
  var state = { suppress: 0, userScrolled: false, wantFrac: NaN, timer: 0, last: 0 }

  function send(msg) {
    try { parent.postMessage(msg, '*') } catch (err) { /* 父页面不在时忽略 */ }
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : NaN }

  function apply(cfg) {
    if (!cfg) return
    var fs = num(cfg.fs)
    if (isFinite(fs) && fs >= 10 && fs <= 60) root.style.setProperty('--rd-fs', fs + 'px')
    var lh = num(cfg.lh)
    if (isFinite(lh) && lh >= 1.2 && lh <= 2.6) root.style.setProperty('--rd-lh', String(lh))
    if (typeof cfg.theme === 'string' && cfg.theme) root.setAttribute('data-rd-theme', cfg.theme)
  }

  apply({ fs: params.get('fs'), theme: params.get('theme') })
  var qFrac = num(params.get('fr'))
  if (isFinite(qFrac)) { state.wantFrac = qFrac; state.userScrolled = false }

  function metrics() {
    var se = document.scrollingElement || root
    var h = Math.max(se.scrollHeight, root.scrollHeight, document.body ? document.body.scrollHeight : 0)
    return { max: Math.max(0, h - window.innerHeight), top: window.pageYOffset || se.scrollTop || 0 }
  }

  function report() {
    var m = metrics()
    send({
      type: 'rd:scroll',
      frac: m.max > 12 ? Math.min(1, Math.max(0, m.top / m.max)) : 0,
      path: location.pathname
    })
  }

  function onScroll() {
    var now = Date.now()
    if (now < state.suppress) return
    if (now - state.last < 120) {
      if (!state.timer) state.timer = setTimeout(function () { state.timer = 0; onScroll() }, 140)
      return
    }
    state.last = now
    state.userScrolled = true
    report()
  }

  function scrollToFrac(f) {
    var m = metrics()
    if (m.max < 8) return false
    state.suppress = Date.now() + 260
    window.scrollTo(0, Math.max(0, Math.min(1, f)) * m.max)
    // 程序化滚动自己不会触发一次有效上报，补一下，父页面才知道位置变了
    setTimeout(report, 160)
    return true
  }

  function restore() {
    if (!isFinite(state.wantFrac) || state.userScrolled) return
    if (scrollToFrac(state.wantFrac)) { state.last = Date.now(); setTimeout(report, 140) }
  }

  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return
    if (d.type === 'rd:config') {
      apply(d)
      if (typeof d.fr === 'number') { state.wantFrac = d.fr; state.userScrolled = false; restore() }
    } else if (d.type === 'rd:scrollTo' && typeof d.fr === 'number') {
      state.userScrolled = false
      scrollToFrac(d.fr)
    }
  })

  window.addEventListener('scroll', onScroll, { passive: true })

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    var k = e.key
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Escape') {
      e.preventDefault()
      send({ type: 'rd:key', key: k })
    }
  })

  document.addEventListener('click', function (e) {
    var t = e.target
    var a = t && t.closest ? t.closest('a[href]') : null
    if (!a) return
    var href = a.getAttribute('href') || ''
    if (href.charAt(0) === '#') return
    var abs
    try { abs = new URL(href, location.href) } catch (err) { return }
    if (abs.protocol === 'epubres:') return
    e.preventDefault()
    send({ type: 'rd:external', url: abs.href })
  })

  function ready() {
    send({ type: 'rd:ready', path: location.pathname, hash: location.hash })
    restore()
    setTimeout(restore, 320)
    if (!isFinite(qFrac)) setTimeout(function () { if (!state.userScrolled) report() }, 420)
  }

  if (document.readyState === 'complete') ready()
  else window.addEventListener('load', ready)
})()
`

function injectReader(html: string): string {
  // EPUB content is untrusted: remove author scripts and inline handlers before
  // adding the small reader bridge owned by the application.
  let out = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/<\?xml[^>]*\?>/gi, '')
  out = out.replace(/<meta[^>]+charset\s*=[^>]*>/gi, '<meta charset="utf-8"/>')
  const inject = `<style id="rd-style">${READER_CSS}</style><script id="rd-boot">${READER_JS}</script>`
  if (/<\/head\s*>/i.test(out)) return out.replace(/<\/head\s*>/i, `${inject}</head>`)
  if (/<body\b[^>]*>/i.test(out)) return out.replace(/<body\b[^>]*>/i, (m) => `${inject}${m}`)
  return inject + out
}

/* ============================ 阅读进度 ============================ */

interface ProgressEntry {
  frac: number
  index: number
  sub: number
  at: number
}

interface ProgressPatch {
  frac?: number
  index?: number
  sub?: number
}

let progressCache: Record<string, ProgressEntry> | null = null

function progressFile(): string {
  return join(app.getPath('userData'), 'reading-progress.json')
}

function loadProgress(): Record<string, ProgressEntry> {
  if (progressCache) return progressCache
  progressCache = {}
  const file = progressFile()
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          const v = value as Partial<ProgressEntry> | null
          if (!v || typeof v.frac !== 'number' || !Number.isFinite(v.frac)) continue
          progressCache[key] = {
            frac: Math.min(1, Math.max(0, v.frac)),
            index: Number.isFinite(v.index) ? Number(v.index) : 0,
            sub: Number.isFinite(v.sub) ? Math.min(1, Math.max(0, Number(v.sub))) : 0,
            at: Number.isFinite(v.at) ? Number(v.at) : 0
          }
        }
      }
    } catch {
      /* 文件损坏就当没有进度，不要因此打不开书 */
    }
  }
  return progressCache
}

function saveProgress(bookId: number, patch: ProgressPatch): { ok: boolean; frac: number } {
  if (!Number.isFinite(bookId) || bookId <= 0) return { ok: false, frac: 0 }
  const store = loadProgress()
  const prev = store[String(bookId)]
  const frac = typeof patch.frac === 'number' && Number.isFinite(patch.frac)
    ? Math.min(1, Math.max(0, patch.frac))
    : prev?.frac ?? 0
  const index = typeof patch.index === 'number' && Number.isFinite(patch.index)
    ? Math.max(0, Math.round(patch.index))
    : prev?.index ?? 0
  const sub = typeof patch.sub === 'number' && Number.isFinite(patch.sub)
    ? Math.min(1, Math.max(0, patch.sub))
    : prev?.sub ?? 0
  store[String(bookId)] = { frac, index, sub, at: Date.now() }
  try {
    writeFileAtomic(progressFile(), JSON.stringify(store))
  } catch {
    /* 写不进就算了，下次打开从头读，不影响当前这一章 */
  }
  // 通知渲染层：底部常驻条的「最近在读」要跟着变，而不是只认 calibre 自己的进度
  ctx.emit(CH.evtReading, { bookId, frac, at: Date.now() })
  return { ok: true, frac }
}

/** 本应用记录的全部阅读进度，供启动时合并到书籍列表 */
export function progressSnapshot(): Record<string, number> {
  const store = loadProgress()
  const out: Record<string, number> = {}
  for (const [id, entry] of Object.entries(store)) out[id] = entry.frac
  return out
}

/* ============================ ReaderInfo ============================ */

function emptyInfo(bookId: number, title: string, authors: string, error: string): ReaderInfo {
  return { bookId, title, authors, base: '', spine: [], posFrac: null, error }
}

function buildReaderInfo(bookId: number): ReaderInfo {
  const lib = ctx.ensureLibrary()
  const book = lib?.book(bookId)
  if (!lib || !book) {
    return emptyInfo(bookId, '', '', '书库里找不到这本书，可能已经被删了。')
  }

  const file = lib.filePath(bookId, 'EPUB')
  const anyFile = file ?? lib.filePath(bookId)
  const title = book.title
  const authors = book.authors

  if (!file) {
    const other = anyFile ? (anyFile.split('.').pop() ?? '').toUpperCase() : ''
    if (other === 'PDF') {
      return emptyInfo(bookId, title, authors, '这本只有 PDF。内置阅读器只读 EPUB，PDF 用「用系统阅读器打开」看。')
    }
    if (other) {
      return emptyInfo(bookId, title, authors, `这本只有 ${other}，没有 EPUB 文件。先在转换页转成 EPUB 再读。`)
    }
    return emptyInfo(bookId, title, authors, '找不到这本书的文件。书库目录可能被移动过。')
  }

  try {
    const archive = openArchive(file)
    const pkg = packageOf(archive)
    if (pkg.spine.length === 0) throw new Error('spine 是空的，没有可读的章节')

    // 目录：EPUB3 的 nav 优先，退到 NCX
    const navItem = [...pkg.manifest.values()].find((i) => i.properties.includes('nav'))
    const ncxItem =
      [...pkg.manifest.values()].find((i) => pkg.tocId && i.id === pkg.tocId) ??
      [...pkg.manifest.values()].find((i) => i.mediaType.includes('dtbncx'))
    const toc: TocItem[] = []
    if (navItem) {
      const navXml = readText(archive, navItem.href)
      if (navXml) toc.push(...parseNav(navXml, dirOf(navItem.href)))
    }
    if (toc.length === 0 && ncxItem) {
      const ncxXml = readText(archive, ncxItem.href)
      if (ncxXml) toc.push(...parseNcx(ncxXml, dirOf(ncxItem.href)))
    }

    const labelByPath = new Map<string, string>()
    for (const item of toc) {
      const key = item.href.toLowerCase()
      if (!item.label || labelByPath.has(key)) continue
      labelByPath.set(key, item.label.length > 80 ? `${item.label.slice(0, 80)}…` : item.label)
    }

    const spine: ReaderSpineItem[] = []
    const coverBase = pkg.coverPath ? (pkg.coverPath.split('/').pop() ?? '').toLowerCase() : ''
    let guessed = 0
    for (const idref of pkg.spine) {
      const item = pkg.manifest.get(idref)
      if (!item) continue
      // 有些书章节文件没有扩展名（xhtml/chapter1），只能靠 manifest 的 media-type 判断
      if (!HTML_TYPES.test(item.mediaType) && !HTML_EXT.test(item.href)) continue
      let label = labelByPath.get(item.href.toLowerCase()) ?? ''
      if (!label && pkg.coverPath && item.href.toLowerCase() === pkg.coverPath.toLowerCase()) {
        label = '封面'
      }
      // 封面页大多没进目录；它要么叫 cover.*，要么第一页里引用了封面图
      if (!label && coverBase && item.href.toLowerCase().includes('cover')) {
        label = '封面'
      }
      if (!label && coverBase && spine.length === 0) {
        const text = readText(archive, item.href)
        if (text && text.toLowerCase().includes(coverBase)) label = '封面'
      }
      if (!label && guessed < 120) {
        label = guessLabel(archive, item.href)
        guessed += 1
      }
      if (!label) label = `第 ${spine.length + 1} 节`
      spine.push({ href: encodePath(item.href), label })
    }
    if (spine.length === 0) throw new Error('spine 里没有 HTML 章节')

    const own = loadProgress()[String(bookId)]
    const posFrac = own ? own.frac : book.posFrac

    return {
      bookId,
      title: pkg.title || title,
      authors: authors || pkg.authors,
      base: `epubres://${bookId}/`,
      spine,
      posFrac: posFrac == null ? null : Math.min(1, Math.max(0, posFrac))
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return emptyInfo(bookId, title, authors, `EPUB 解析失败：${msg}`)
  }
}

/* ============================ epubres 协议 ============================ */

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xhtml: 'text/html; charset=utf-8',
  xht: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  opf: 'application/xml; charset=utf-8',
  ncx: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8'
}

const TEXTUAL = /^(text\/|application\/(xml|json|xhtml))/i

/** 类型优先取 OPF 里声明的 media-type（章节可能压根没有扩展名），再退回扩展名 */
function contentTypeOf(path: string, mediaType: string): string {
  const mt = mediaType.toLowerCase()
  if (/^(image|font|audio|video)\//.test(mt)) return mt
  if (mt === 'text/css') return 'text/css; charset=utf-8'
  if (mt === 'text/javascript' || mt === 'application/javascript') return 'text/javascript; charset=utf-8'
  if (HTML_TYPES.test(mt)) return 'text/html; charset=utf-8'
  if (/xml$/.test(mt)) return 'application/xml; charset=utf-8'
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

function isHtmlLike(path: string, mediaType: string): boolean {
  return HTML_TYPES.test(mediaType) || HTML_EXT.test(path)
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/**
 * 从 URL 里取书号。`epubres` 注册成了 standard 协议，Chromium 会把纯数字的
 * 主机名当 IPv4 规范化（591 → 0.0.2.79），所以这里要把点分地址还原成整数。
 */
function bookIdOf(url: URL): number {
  const raw = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0] || ''
  const direct = Number(raw)
  if (Number.isInteger(direct) && direct > 0) return direct
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw)
  if (!m) return 0
  const parts = m.slice(1).map((x) => Number(x))
  if (parts.some((n) => n < 0 || n > 255)) return 0
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function serveEpub(request: Request): Response {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return textResponse('地址看不懂', 400)
  }

  const bookId = bookIdOf(url)
  if (!Number.isFinite(bookId) || bookId <= 0) return textResponse('缺少书号', 400)

  const lib = ctx.ensureLibrary()
  const file = lib?.filePath(bookId, 'EPUB')
  if (!file) return textResponse('找不到这本书的 EPUB 文件', 404)

  let archive: ZipArchive
  try {
    archive = openArchive(file)
  } catch (e) {
    return textResponse(`EPUB 解包失败：${e instanceof Error ? e.message : String(e)}`, 500)
  }

  const requested = normalizePath(safeDecode(url.pathname).replace(/^\/+/, ''))
  if (!requested) return textResponse('缺少包内路径', 400)

  const entry = findEntry(archive, requested)
  if (!entry) return textResponse(`EPUB 里没有这个文件：${requested}`, 404)

  // 目录解析失败也要能取到图片/CSS，所以这里单独兜一层
  let mediaType = ''
  try {
    mediaType = packageOf(archive).mediaTypes.get(entry.name.toLowerCase()) ?? ''
  } catch {
    /* 没有可用的 OPF，按扩展名走 */
  }

  let bytes: Buffer
  try {
    bytes = extractEntry(archive, entry)
  } catch (e) {
    return textResponse(`读取失败：${e instanceof Error ? e.message : String(e)}`, 500)
  }

  if (isHtmlLike(entry.name, mediaType)) {
    const cached = archive.pageCache.get(entry.name)
    const html = cached ?? injectReader(decodeText(bytes))
    if (!cached) archive.pageCache.set(entry.name, html)
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache'
      }
    })
  }

  const contentType = contentTypeOf(entry.name, mediaType)
  let body = bytes
  if (TEXTUAL.test(contentType)) {
    // CSS / XML 里也可能带别的编码，统一转成 UTF-8
    body = Buffer.from(decodeText(bytes), 'utf8')
  }

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': contentType,
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache'
    }
  })
}

/* ============================ 注册 ============================ */

export function registerEpub(): void {
  protocol.handle('epubres', (request) => serveEpub(request))

  ipcMain.handle(CH.readerInfo, (_event, bookId: number) => buildReaderInfo(Number(bookId)))

  ipcMain.handle(CH.readerSaveProgress, (_event, bookId: number, patch: ProgressPatch) =>
    saveProgress(Number(bookId), patch ?? {})
  )

  ipcMain.handle(CH.readerProgress, () => progressSnapshot())
}
