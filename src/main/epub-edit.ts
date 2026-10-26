/**
 * 内置电子书编辑器（对应 calibre 的 Edit book）。
 *
 * 读的方向和阅读器一样：EOCD → 中央目录 → local file header → inflateRawSync。
 * 写回比读麻烦得多：zip 不能就地改长度，只能整包重建。
 *
 * 写回的三条底线：
 *  1. 未改动的条目直接拷原始压缩字节，连 CRC 都不动 —— 逐字节保持原样；
 *     改过的条目按原压缩方式重新压，CRC32 自己算（表驱动，不引依赖）。
 *  2. `mimetype` 永远排第一个且 method=0（stored），否则 EPUB 校验不过。
 *  3. 先写同目录临时文件 → 重新解析这个新文件核对全部条目 → 再 rename 覆盖；
 *     写之前另存一份备份，保留最近 5 份。
 */
import { app, ipcMain } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { CH } from '../shared/ipc'
import type { EpubFileContent, EpubFileEntry } from '../shared/types'
import { ctx } from './ctx'
import { isCalibreRunning } from './env'
import { logger } from './logger'

/** 编辑器只处理这个大小以内的文本；超过就是拿错文件了 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** 每本书留几份备份 */
const MAX_BACKUPS = 5

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const ZIP64_LOC_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50

/* ============================ zip 解析 ============================ */

interface ZipEntry {
  /** 规范化后的包内路径（正斜杠、无前导 /） */
  path: string
  /** 原始文件名字节，写回时原样写出去（可能有非 UTF-8 的名字） */
  rawName: Buffer
  /** 目录条目（名字以 / 结尾） */
  isDir: boolean
  flags: number
  method: number
  crc: number
  compSize: number
  size: number
  localOffset: number
  /** local header 里的扩展字段，写回时原样保留 */
  localExtra: Buffer
  /** 中央目录里的扩展字段 */
  centralExtra: Buffer
  comment: Buffer
  versionMadeBy: number
  versionNeeded: number
  time: number
  date: number
  internalAttr: number
  externalAttr: number
}

interface ParsedZip {
  buffer: Buffer
  entries: ZipEntry[]
  byName: Map<string, ZipEntry>
}

/** 去掉 . / .. 和多余的分隔符，统一成正斜杠；目录条目的结尾 / 也去掉 */
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

function findEocd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** 文件名：优先 UTF-8（标志位 11），解出替换字符时按 GB18030 再试一次 */
function decodeName(raw: Buffer): string {
  let name = raw.toString('utf8')
  if (name.includes('\uFFFD')) {
    try {
      name = new TextDecoder('gb18030', { fatal: true }).decode(raw)
    } catch {
      /* 保持 UTF-8 的结果 */
    }
  }
  return name
}

/** 从 zip64 扩展字段里补出真实长度/偏移（超 4GB 的包才会用到，读还是要读对） */
function readZip64Extra(
  extra: Buffer,
  size: number,
  compSize: number,
  localOffset: number
): { size: number; compSize: number; localOffset: number } {
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
      const end = p + 4 + len
      if (needSize && q + 8 <= end) {
        out = { ...out, size: Number(extra.readBigUInt64LE(q)) }
        q += 8
        needSize = false
      }
      if (needComp && q + 8 <= end) {
        out = { ...out, compSize: Number(extra.readBigUInt64LE(q)) }
        q += 8
        needComp = false
      }
      if (needOffset && q + 8 <= end) {
        out = { ...out, localOffset: Number(extra.readBigUInt64LE(q)) }
        needOffset = false
      }
      break
    }
    p += 4 + len
  }
  return out
}

function parseZip(buffer: Buffer): ParsedZip {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('这个文件不是有效的 EPUB：找不到 zip 结尾记录')

  let count = buffer.readUInt16LE(eocd + 10)
  let cdOffset = buffer.readUInt32LE(eocd + 16)

  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20
    if (loc >= 0 && buffer.readUInt32LE(loc) === ZIP64_LOC_SIG) {
      const z64 = Number(buffer.readBigUInt64LE(loc + 8))
      if (z64 > 0 && z64 + 56 <= buffer.length && buffer.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
        count = Number(buffer.readBigUInt64LE(z64 + 32))
        cdOffset = Number(buffer.readBigUInt64LE(z64 + 48))
      }
    }
  }
  if (cdOffset <= 0 || cdOffset >= buffer.length) throw new Error('EPUB 的 zip 中央目录位置不对')

  const entries: ZipEntry[] = []
  const byName = new Map<string, ZipEntry>()
  let p = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CEN_SIG) {
      throw new Error('EPUB 的 zip 中央目录损坏')
    }
    const versionMadeBy = buffer.readUInt16LE(p + 4)
    const versionNeeded = buffer.readUInt16LE(p + 6)
    const flags = buffer.readUInt16LE(p + 8)
    const method = buffer.readUInt16LE(p + 10)
    const time = buffer.readUInt16LE(p + 12)
    const date = buffer.readUInt16LE(p + 14)
    const crc = buffer.readUInt32LE(p + 16)
    let compSize = buffer.readUInt32LE(p + 20)
    let size = buffer.readUInt32LE(p + 24)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const internalAttr = buffer.readUInt16LE(p + 36)
    const externalAttr = buffer.readUInt32LE(p + 38)
    let localOffset = buffer.readUInt32LE(p + 42)
    const rawName = buffer.subarray(p + 46, p + 46 + nameLen)
    const centralExtra = buffer.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    const comment = buffer.subarray(
      p + 46 + nameLen + extraLen,
      p + 46 + nameLen + extraLen + commentLen
    )
    if (size === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      const filled = readZip64Extra(centralExtra, size, compSize, localOffset)
      size = filled.size
      compSize = filled.compSize
      localOffset = filled.localOffset
    }

    const name = decodeName(rawName)
    const isDir = name.endsWith('/')
    const path = normalizePath(name)
    if (!path) continue

    // local header 的扩展字段和中央目录里的可以不一样，分开留着
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`zip 条目损坏：${path}`)
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const localExtra = buffer.subarray(
      localOffset + 30 + localNameLen,
      localOffset + 30 + localNameLen + localExtraLen
    )

    const entry: ZipEntry = {
      path,
      rawName,
      isDir,
      flags,
      method,
      crc,
      compSize,
      size,
      localOffset,
      localExtra,
      centralExtra,
      comment,
      versionMadeBy,
      versionNeeded,
      time,
      date,
      internalAttr,
      externalAttr
    }
    entries.push(entry)
    if (!byName.has(path)) byName.set(path, entry)
    p += 46 + nameLen + extraLen + commentLen
  }

  if (entries.length === 0) throw new Error('EPUB 里没有可用的文件')
  return { buffer, entries, byName }
}

function dataOffset(zip: ParsedZip, entry: ZipEntry): number {
  const p = entry.localOffset
  if (p + 30 > zip.buffer.length || zip.buffer.readUInt32LE(p) !== LOC_SIG) {
    throw new Error(`zip 条目损坏：${entry.path}`)
  }
  const nameLen = zip.buffer.readUInt16LE(p + 26)
  const extraLen = zip.buffer.readUInt16LE(p + 28)
  return p + 30 + nameLen + extraLen
}

/** 压缩态字节（写回时未改动的条目直接用它，保证逐字节不变） */
function rawBytes(zip: ParsedZip, entry: ZipEntry): Buffer {
  const start = dataOffset(zip, entry)
  const end = start + entry.compSize
  if (end > zip.buffer.length) throw new Error(`zip 条目被截断：${entry.path}`)
  return zip.buffer.subarray(start, end)
}

function readEntry(zip: ParsedZip, entry: ZipEntry): Buffer {
  const raw = rawBytes(zip, entry)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`不支持的压缩方式 ${entry.method}：${entry.path}`)
}

/* ============================ CRC32 ============================ */

let crcTable: Uint32Array | null = null

function crc32(buf: Buffer): number {
  if (!crcTable) {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    crcTable = table
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ============================ 重建 zip ============================ */

interface PlannedEntry {
  path: string
  name: Buffer
  flags: number
  method: number
  versionMadeBy: number
  versionNeeded: number
  time: number
  date: number
  crc: number
  size: number
  /** 压缩后的字节 */
  data: Buffer
  localExtra: Buffer
  centralExtra: Buffer
  comment: Buffer
  internalAttr: number
  externalAttr: number
  /** 这次改动的内容（明文），写回后核对用 */
  edited?: Buffer
}

function planZip(zip: ParsedZip, edits: Map<string, Buffer>): PlannedEntry[] {
  const mimetype = zip.byName.get('mimetype')
  const order: ZipEntry[] = []
  if (mimetype) order.push(mimetype)
  for (const entry of zip.entries) {
    if (entry === mimetype) continue
    order.push(entry)
  }

  // 极少数包没有 mimetype；补一个，否则写出去的书不合法
  const synthetic: ZipEntry | null = mimetype
    ? null
    : {
        path: 'mimetype',
        rawName: Buffer.from('mimetype', 'ascii'),
        isDir: false,
        flags: 0x0800,
        method: 0,
        crc: 0,
        compSize: 0,
        size: 0,
        localOffset: 0,
        localExtra: Buffer.alloc(0),
        centralExtra: Buffer.alloc(0),
        comment: Buffer.alloc(0),
        versionMadeBy: 20,
        versionNeeded: 20,
        time: 0,
        date: 0,
        internalAttr: 0,
        externalAttr: 0
      }
  if (synthetic) order.unshift(synthetic)

  const planned: PlannedEntry[] = []
  for (const entry of order) {
    const isMimetype = entry.path === 'mimetype' && !entry.isDir
    const edit = edits.get(entry.path)
    // 压缩方式保持原样；mimetype 强制 stored
    const method = isMimetype ? 0 : entry.method
    let plain: Buffer | null = null
    let data: Buffer
    let size: number
    let crc: number

    if (edit) {
      plain = edit
      size = edit.length
      crc = crc32(edit)
      data = method === 0 ? edit : deflateRawSync(edit)
    } else if (isMimetype || (method === 0 && entry.method !== 0)) {
      plain = readEntry(zip, entry)
      size = plain.length
      crc = crc32(plain)
      data = plain
    } else {
      data = rawBytes(zip, entry)
      size = entry.size
      crc = entry.crc
      if (crc === 0 && size > 0) {
        // 个别包的中央目录 CRC 写 0，重建时补对，否则新包不合法
        plain = readEntry(zip, entry)
        size = plain.length
        crc = crc32(plain)
      }
    }

    // 长度必须放得进 32 位；EPUB 不可能到 4GB，真碰上了直接报错而不是写出坏包
    if (size > 0xfffffffe || data.length > 0xfffffffe) {
      throw new Error(`条目太大，暂时写不了：${entry.path}`)
    }

    const versionNeeded = method === 8 ? Math.max(20, entry.versionNeeded) : entry.versionNeeded || 20
    planned.push({
      path: entry.path,
      name: entry.rawName,
      // 清掉 bit 3：我们自己写长度，不需要 data descriptor
      flags: entry.flags & ~0x0008,
      method,
      versionMadeBy: entry.versionMadeBy,
      versionNeeded,
      time: entry.time,
      date: entry.date,
      crc,
      size,
      data,
      localExtra: entry.localExtra,
      centralExtra: entry.centralExtra,
      comment: entry.comment,
      internalAttr: entry.internalAttr,
      externalAttr: entry.externalAttr,
      edited: plain && edit ? plain : undefined
    })
  }
  return planned
}

function serializeZip(planned: PlannedEntry[]): Buffer {
  if (planned.length > 0xfffe) throw new Error('EPUB 里文件太多，暂时写不了')

  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of planned) {
    const nameLen = entry.name.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOC_SIG, 0)
    local.writeUInt16LE(entry.versionNeeded, 4)
    local.writeUInt16LE(entry.flags, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(entry.time, 10)
    local.writeUInt16LE(entry.date, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.size, 22)
    local.writeUInt16LE(nameLen, 26)
    local.writeUInt16LE(entry.localExtra.length, 28)
    locals.push(local, entry.name, entry.localExtra, entry.data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(CEN_SIG, 0)
    cen.writeUInt16LE(entry.versionMadeBy, 4)
    cen.writeUInt16LE(entry.versionNeeded, 6)
    cen.writeUInt16LE(entry.flags, 8)
    cen.writeUInt16LE(entry.method, 10)
    cen.writeUInt16LE(entry.time, 12)
    cen.writeUInt16LE(entry.date, 14)
    cen.writeUInt32LE(entry.crc, 16)
    cen.writeUInt32LE(entry.data.length, 20)
    cen.writeUInt32LE(entry.size, 24)
    cen.writeUInt16LE(nameLen, 28)
    cen.writeUInt16LE(entry.centralExtra.length, 30)
    cen.writeUInt16LE(entry.comment.length, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(entry.internalAttr, 36)
    cen.writeUInt32LE(entry.externalAttr, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, entry.name, entry.centralExtra, entry.comment)

    offset += 30 + nameLen + entry.localExtra.length + entry.data.length
    if (offset > 0xfffffffe) throw new Error('这个 EPUB 超过 4 GB，暂时写不了')
  }

  const cdSize = central.reduce((sum, b) => sum + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(planned.length, 8)
  eocd.writeUInt16LE(planned.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...central, eocd])
}

/* ============================ 文本 ============================ */

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'ico'])
const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot'])
const EDITABLE = new Set<EpubFileEntry['kind']>(['html', 'css', 'opf'])

function kindOf(path: string): EpubFileEntry['kind'] {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (ext === 'xhtml' || ext === 'html' || ext === 'htm' || ext === 'xht') return 'html'
  if (ext === 'css') return 'css'
  if (ext === 'opf' || ext === 'ncx') return 'opf'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (FONT_EXT.has(ext)) return 'font'
  return 'other'
}

function isUtf8Label(label: string): boolean {
  const l = label.toLowerCase().replace(/[_\s]/g, '-')
  return l === 'utf-8' || l === 'utf8' || l === 'us-ascii' || l === 'ascii'
}

/** 按 BOM / XML 声明 / meta charset / @charset 猜编码，再回退 UTF-8、GB18030 */
function decodeText(bytes: Buffer): { text: string; encoding: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf-8' }
  }
  const head = bytes.subarray(0, 4096).toString('latin1')
  const declared = (
    /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    /@charset\s+["']([\w.:-]+)["']/i.exec(head)?.[1] ??
    ''
  ).toLowerCase()

  for (const label of [declared, 'utf-8', 'gb18030'].filter((x) => x.length > 0)) {
    try {
      return { text: new TextDecoder(label, { fatal: true }).decode(bytes), encoding: label }
    } catch {
      /* 试下一个 */
    }
  }
  return { text: bytes.toString('utf8'), encoding: 'utf-8' }
}

/**
 * 原文件不是 UTF-8 时（老书常见 GBK），写回会变成 UTF-8。
 * 编码变了声明也得跟着改，否则下次打开就是乱码。
 */
function patchCharset(text: string, kind: EpubFileEntry['kind']): string {
  if (kind === 'html' || kind === 'opf') {
    let out = text.replace(/<\?xml([^>]*)encoding\s*=\s*["'][^"']*["']/i, (whole) =>
      whole.replace(/encoding\s*=\s*["'][^"']*["']/i, 'encoding="utf-8"')
    )
    out = out.replace(/<meta\b[^>]*charset\s*=[^>]*>/gi, '<meta charset="utf-8"/>')
    return out
  }
  if (kind === 'css') {
    return text.replace(/@charset\s+["'][^"']+["']\s*;/i, '@charset "utf-8";')
  }
  return text
}

/** 没有解码成文本的字节（图片、字体、压缩包里的杂项） */
function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096))
  for (let i = 0; i < head.length; i += 1) if (head[i] === 0) return true
  return false
}

/* ============================ 书 / 备份 ============================ */

function bookPath(bookId: number): string {
  if (!Number.isFinite(bookId) || bookId <= 0) throw new Error('没有拿到书号')
  const lib = ctx.ensureLibrary()
  if (!lib) throw new Error('书库还没就绪，稍后再试。')
  if (!lib.book(bookId)) throw new Error('书库里找不到这本书了。')
  const file = lib.filePath(bookId, 'EPUB')
  if (file) return file
  const other = lib.filePath(bookId)
  const ext = other ? (other.split('.').pop() ?? '').toUpperCase() : ''
  if (ext) throw new Error(`这本只有 ${ext}，编辑器只处理 EPUB。`)
  throw new Error('找不到这本书的文件，书库目录可能被移动过。')
}

function backupDir(): string {
  return join(app.getPath('userData'), 'epub-backups')
}

/** 一次只缓存一本（编辑器里翻文件很频繁）；写回后 mtime 变了会自动重新解析 */
let cached: { file: string; mtimeMs: number; size: number; zip: ParsedZip } | null = null

function loadBook(bookId: number): { file: string; zip: ParsedZip } {
  const file = bookPath(bookId)
  const stat = statSync(file)
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { file, zip: cached.zip }
  }
  const zip = parseZip(readFileSync(file))
  cached = { file, mtimeMs: stat.mtimeMs, size: stat.size, zip }
  return { file, zip }
}

function backupNames(bookId: number): string[] {
  const dir = backupDir()
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(`${bookId}-`) && name.endsWith('.epub'))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function makeBackup(file: string, bookId: number): string {
  const dir = backupDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
  const target = join(dir, `${bookId}-${stamp}.epub`)
  copyFileSync(file, target)
  // 只留最近几份，旧的删掉
  for (const old of backupNames(bookId).slice(MAX_BACKUPS)) {
    try {
      rmSync(join(dir, old), { force: true })
    } catch {
      /* 删不掉就算了，不影响这次保存 */
    }
  }
  return target
}

/* ============================ 五个 IPC 动作 ============================ */

function listFiles(bookId: number): EpubFileEntry[] {
  const { zip } = loadBook(bookId)
  const out: EpubFileEntry[] = []
  for (const entry of zip.entries) {
    if (entry.isDir) continue
    const kind = kindOf(entry.path)
    out.push({
      path: entry.path,
      name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
      size: entry.size,
      kind,
      editable: EDITABLE.has(kind)
    })
  }
  return out
}

function readFileContent(bookId: number, rawPath: string): EpubFileContent {
  const raw = String(rawPath ?? '')
  const path = normalizePath(raw)
  const blank: EpubFileContent = { path, text: '', status: 'missing', bytes: 0 }
  if (!path || raw.includes('..')) return blank

  const { zip } = loadBook(bookId)
  const entry = zip.byName.get(path)
  if (!entry || entry.isDir) return blank

  const kind = kindOf(path)
  if (kind === 'image' || kind === 'font') {
    return { path, text: '', status: 'binary', bytes: entry.size }
  }
  if (entry.size > MAX_TEXT_BYTES) {
    return { path, text: '', status: 'too-large', bytes: entry.size }
  }
  const bytes = readEntry(zip, entry)
  if (looksBinary(bytes)) return { path, text: '', status: 'binary', bytes: entry.size }
  return { path, text: decodeText(bytes).text, status: 'ok', bytes: entry.size }
}

/** 写回后重新解析一遍新文件，确认条目和内容都对得上 */
function verifyWritten(
  file: string,
  planned: PlannedEntry[],
  editedPath: string,
  editedBytes: Buffer
): string | null {
  const fresh = parseZip(readFileSync(file))
  if (fresh.entries.length !== planned.length) return '条目数量对不上'
  const first = fresh.entries[0]
  if (!first || first.path !== 'mimetype' || first.method !== 0) {
    return 'mimetype 不在第一个或者不是未压缩'
  }
  for (const want of planned) {
    const got = fresh.byName.get(want.path)
    if (!got) return `少了条目 ${want.path}`
    if (got.method !== want.method) return `压缩方式变了：${want.path}`
    if (got.size !== want.size) return `长度变了：${want.path}`
    if (got.crc !== want.crc) return `CRC 对不上：${want.path}`
  }
  const edited = fresh.byName.get(editedPath)
  if (!edited) return `改的那个文件不见了：${editedPath}`
  if (!readEntry(fresh, edited).equals(editedBytes)) return `改的内容没写对：${editedPath}`
  return null
}

async function writeFileContent(
  bookId: number,
  rawPath: string,
  text: string
): Promise<{ ok: boolean; message: string }> {
  try {
    if (typeof text !== 'string') return { ok: false, message: '没有收到正文' }
    const path = normalizePath(String(rawPath ?? ''))
    if (!path) return { ok: false, message: '没有指定要保存的文件' }
    if (String(rawPath).includes('..')) return { ok: false, message: '路径不合法，不能写到包外面去' }

    const kind = kindOf(path)
    if (!EDITABLE.has(kind)) {
      return { ok: false, message: '图片、字体和杂项文件不能在编辑器里改' }
    }
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > MAX_TEXT_BYTES) {
      return { ok: false, message: '正文超过 2 MB，编辑器不处理这么大的文件' }
    }

    const file = bookPath(bookId)
    if (await isCalibreRunning()) {
      return { ok: false, message: 'calibre 正在运行，先关掉它再保存，不然书库是锁死的' }
    }

    const zip = loadBook(bookId).zip
    const entry = zip.byName.get(path)
    if (!entry || entry.isDir) {
      return { ok: false, message: 'EPUB 里没有这个文件，刷新一下文件列表再试' }
    }

    // 原文件编码不是 UTF-8 时，写回变成 UTF-8，声明跟着改
    const original = readEntry(zip, entry)
    const { encoding } = decodeText(original)
    const finalBytes = isUtf8Label(encoding) ? bytes : Buffer.from(patchCharset(text, kind), 'utf8')

    const backup = makeBackup(file, bookId)
    const planned = planZip(zip, new Map([[path, finalBytes]]))
    const out = serializeZip(planned)

    const dir = dirname(file)
    const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`)
    try {
      writeFileSync(tmp, out)
      const problem = verifyWritten(tmp, planned, path, finalBytes)
      if (problem) {
        rmSync(tmp, { force: true })
        return { ok: false, message: `写回校验没过（${problem}），原文件没动` }
      }
      renameSync(tmp, file)
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, message: `写文件失败：${msg}。原文件没动` }
    }

    ctx.reload()
    logger.info('电子书编辑器：写回', { bookId, path, bytes: finalBytes.length, backup })
    return { ok: true, message: '已写回 EPUB' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('电子书编辑器：写回失败', { bookId, path: rawPath, message: msg })
    return { ok: false, message: msg }
  }
}

async function revertBook(bookId: number): Promise<{ ok: boolean; message: string }> {
  try {
    const file = bookPath(bookId)
    if (await isCalibreRunning()) {
      return { ok: false, message: 'calibre 正在运行，先关掉它再还原' }
    }
    const names = backupNames(bookId)
    const latest = names[0]
    if (!latest) return { ok: false, message: '这本书还没有备份，没东西可还原' }

    const src = join(backupDir(), latest)
    const tmp = join(dirname(file), `.${basename(file)}.revert.${process.pid}.${Date.now()}.tmp`)
    try {
      copyFileSync(src, tmp)
      // 备份本身也要能读，坏备份别拿来盖好文件
      parseZip(readFileSync(tmp))
      renameSync(tmp, file)
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, message: `还原失败：${msg}` }
    }

    ctx.reload()
    logger.info('电子书编辑器：还原', { bookId, backup: latest })
    return { ok: true, message: `已还原到 ${latest}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error('电子书编辑器：还原失败', { bookId, message: msg })
    return { ok: false, message: msg }
  }
}

export function registerEpubEdit(): void {
  ipcMain.handle(CH.epubList, (_event, bookId: number) => {
    try {
      return listFiles(Number(bookId))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error('电子书编辑器：列文件失败', { bookId, message: msg })
      throw new Error(msg)
    }
  })

  ipcMain.handle(CH.epubRead, (_event, bookId: number, path: string) => {
    try {
      return readFileContent(Number(bookId), path)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error('电子书编辑器：读文件失败', { bookId, path, message: msg })
      throw new Error(msg)
    }
  })

  ipcMain.handle(CH.epubWrite, (_event, bookId: number, path: string, text: string) =>
    writeFileContent(Number(bookId), path, text)
  )

  ipcMain.handle(CH.epubRevert, (_event, bookId: number) => revertBook(Number(bookId)))

  ipcMain.handle(CH.epubBackupList, (_event, bookId: number) => {
    try {
      return backupNames(Number(bookId))
    } catch (e) {
      logger.error('电子书编辑器：读备份列表失败', e)
      return []
    }
  })
}
