/**
 * 设备 / 推送后端。
 *
 * 两条通道：
 *  - USB：Kindle 插上后是一个盘符，根目录同时有 documents/ 与 system/。
 *    只往 <盘符>\documents\<子目录>\ 里塞 EPUB —— 放盘符根目录或书库目录 Kindle 扫不到。
 *  - SMTP：Amazon 自 2022 起「发送至 Kindle」只收 EPUB / PDF / DOCX，不要再转 MOBI/KFX。
 *    QQ / 163 走授权码而不是登录密码，本机不装 nodemailer，用 node:net / node:tls 写了个最小客户端
 *    （465 隐式 TLS、587 STARTTLS、AUTH LOGIN）。
 *
 * 凭据统一放在 ctx.settings 里（SettingsStore 内部用 safeStorage 加密落盘），这里只读不写。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, statSync } from 'node:fs'
import { readdir, stat, statfs } from 'node:fs/promises'
import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import type { KindleDevice, SendResult, SmtpSettings } from '../shared/types'
import { ctx } from './ctx'

/** 单封邮件（含附件）上限，来自「设置 → 设备与推送 → 附件上限」，默认 25 MB */
function maxMailBytes(): number {
  const mb = Number(ctx.settings?.get().device.maxAttachmentMB ?? 25)
  const safe = Number.isFinite(mb) && mb > 0 ? mb : 25
  return safe * 1024 * 1024
}
/** 复制到 Kindle 时预留的余量，避免把设备塞到 0 字节 */
const DEVICE_RESERVE_BYTES = 20 * 1024 * 1024
/** documents 下的默认子目录，来自设置，别直接摊在 documents 根目录里 */
function defaultSubdir(): string {
  const raw = ctx.settings?.get().device.usbSubdir?.trim()
  return raw && raw.length > 0 ? raw : 'eebookk'
}

/** 渲染层传下来的推送参数 */
export interface DeviceSendPayload {
  bookIds: number[]
  /** usb = 复制到 Kindle 盘符；email = 走 SMTP 发送 */
  mode: 'usb' | 'email'
  /** USB 模式可指定盘符，不传就自动检测第一台 Kindle */
  mountPath?: string
  /** documents 下的子目录名，默认 eebookk */
  subdir?: string
  /** 邮件主题，留空按书名自动生成 */
  subject?: string
}

export interface DeviceSendItem {
  id: number
  title: string
  ok: boolean
  message: string
}

/** 逐本给结果，前端据此列出成功 / 失败清单 */
export interface DeviceSendResult {
  ok: boolean
  message: string
  items: DeviceSendItem[]
  /** USB 模式下实际写入的目录 */
  targetPath?: string
}

/* ---------------- 通用小工具 ---------------- */

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** Windows 文件名不能带这些字符，顺手裁长度 */
function safeName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return (cleaned || '未命名').slice(0, 100)
}

/** 同名文件不覆盖，依次加 (2) (3) */
function freshPath(dir: string, base: string, ext: string): string {
  let candidate = join(dir, `${base}${ext}`)
  let i = 2
  while (existsSync(candidate) && i <= 200) {
    candidate = join(dir, `${base} (${i})${ext}`)
    i += 1
  }
  return candidate
}

function normalizePayload(raw: unknown): DeviceSendPayload {
  const p = (raw ?? {}) as Partial<DeviceSendPayload>
  const ids = Array.isArray(p.bookIds) ? p.bookIds.map((n) => Number(n)) : []
  return {
    bookIds: ids.filter((n) => Number.isInteger(n) && n > 0),
    mode: p.mode === 'email' ? 'email' : 'usb',
    mountPath: typeof p.mountPath === 'string' ? p.mountPath : undefined,
    subdir: typeof p.subdir === 'string' ? p.subdir : undefined,
    subject: typeof p.subject === 'string' ? p.subject : undefined
  }
}

/* ---------------- USB 设备检测 ---------------- */

const BOOK_FILE = /\.(epub|pdf|docx|azw3|mobi|txt|kfx)$/i

/** 单盘符探测超时：断开的网络盘会让同步 fs 调用卡死主进程，这里一律异步 + 超时 */
const DRIVE_TIMEOUT_MS = 1200
/** 检测结果缓存，避免每次进设备页都重扫 26 个盘符 */
const DETECT_TTL_MS = 8000

let detectCache: { at: number; list: KindleDevice[] } | null = null

function withTimeout<T>(p: Promise<T>, fallback: T, ms = DRIVE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

async function isDirAsync(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

function driveLetters(): string[] {
  const out: string[] = []
  for (let c = 65; c <= 90; c += 1) out.push(`${String.fromCharCode(c)}:\\`)
  return out
}

async function countBookFiles(dir: string, depth = 0): Promise<number> {
  if (depth > 4) return 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return 0
  let n = 0
  for (const entry of entries) {
    if (entry.isDirectory()) n += await countBookFiles(join(dir, entry.name), depth + 1)
    else if (BOOK_FILE.test(String(entry.name))) n += 1
  }
  return n
}

async function probeDrive(drive: string): Promise<KindleDevice | null> {
  const documents = join(drive, 'documents')
  const [hasDocs, hasSystem] = await Promise.all([
    isDirAsync(documents),
    isDirAsync(join(drive, 'system'))
  ])
  if (!hasDocs || !hasSystem) return null
  let freeBytes = 0
  let totalBytes = 0
  try {
    const st = await statfs(drive)
    freeBytes = Number(st.bavail) * Number(st.bsize)
    totalBytes = Number(st.blocks) * Number(st.bsize)
  } catch {
    /* 个别盘符读不到容量，不影响识别 */
  }
  return {
    mountPath: drive,
    label: `Kindle (${drive.slice(0, 2)})`,
    freeBytes,
    totalBytes,
    documentCount: await countBookFiles(documents)
  }
}

/** 遍历盘符找 Kindle：根目录同时有 documents/ 与 system/ 才认。结果缓存 8 秒。 */
export async function detectKindle(force = false): Promise<KindleDevice[]> {
  if (!force && detectCache && Date.now() - detectCache.at < DETECT_TTL_MS) {
    return detectCache.list
  }
  const results = await Promise.all(driveLetters().map((d) => withTimeout(probeDrive(d), null)))
  const list = results.filter((x): x is KindleDevice => x != null)
  detectCache = { at: Date.now(), list }
  return list
}

function freeSpaceOf(root: string): number {
  try {
    const stat = statfsSync(root)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return 0
  }
}

/* ---------------- USB 复制 ---------------- */

export async function pushToDevice(payload: DeviceSendPayload): Promise<DeviceSendResult> {
  const items: DeviceSendItem[] = []
  if (!payload.bookIds.length) return { ok: false, message: '还没有选书', items }
  const lib = ctx.ensureLibrary()
  if (!lib) return { ok: false, message: '书库未就绪', items }

  // 优先用传入的盘符（页面刷新后可能和检测结果不一致），否则重新检测一次
  const mounted = payload.mountPath && isDir(join(payload.mountPath, 'documents'))
  const mountPath = mounted
    ? payload.mountPath
    : (await detectKindle())[0]?.mountPath
  if (!mountPath) {
    return {
      ok: false,
      message: '没有检测到 Kindle。请用数据线连接，并在设备弹出的提示里点「连接」；只充电模式不会出现盘符。',
      items
    }
  }
  const root = mountPath.endsWith('\\') ? mountPath : `${mountPath}\\`
  const targetDir = join(root, 'documents', safeName(payload.subdir ?? defaultSubdir()))

  // 先算一遍要占多少空间，空间不够就整体拒绝，不写半截
  const todo: { id: number; title: string; file: string; size: number }[] = []
  for (const id of payload.bookIds) {
    const book = lib.book(id)
    if (!book) {
      items.push({ id, title: String(id), ok: false, message: '书库里找不到这本书' })
      continue
    }
    const file = lib.filePath(id, 'EPUB')
    if (!file) {
      items.push({
        id,
        title: book.title,
        ok: false,
        message: `没有 EPUB（现有 ${book.formats.join(' / ') || '无格式'}），请先到「转换」页转成 EPUB 再推送`
      })
      continue
    }
    todo.push({ id, title: book.title, file, size: sizeOf(file) })
  }

  const need = todo.reduce((sum, t) => sum + t.size, 0)
  const free = freeSpaceOf(root)
  if (free > 0 && need + DEVICE_RESERVE_BYTES > free) {
    for (const t of todo) {
      items.push({ id: t.id, title: t.title, ok: false, message: 'Kindle 剩余空间不足' })
    }
    return {
      ok: false,
      message: `Kindle 剩余空间不足：需要 ${formatBytes(need)}，可用 ${formatBytes(free)}`,
      items,
      targetPath: targetDir
    }
  }

  try {
    mkdirSync(targetDir, { recursive: true })
  } catch (e) {
    return {
      ok: false,
      message: `无法在 Kindle 上创建目录：${(e as Error).message}`,
      items,
      targetPath: targetDir
    }
  }

  let copied = 0
  for (const t of todo) {
    try {
      const dest = freshPath(targetDir, safeName(t.title), '.epub')
      copyFileSync(t.file, dest)
      copied += 1
      items.push({ id: t.id, title: t.title, ok: true, message: `已复制到 ${dest}` })
    } catch (e) {
      items.push({ id: t.id, title: t.title, ok: false, message: `复制失败：${(e as Error).message}` })
    }
  }

  const failed = items.filter((item) => !item.ok).length
  return {
    ok: failed === 0,
    message:
      failed === 0
        ? `已把 ${copied} 本书复制到 Kindle 的 documents\\${safeName(payload.subdir ?? defaultSubdir())} 下，安全弹出后在设备上刷新书库即可看到`
        : `复制成功 ${copied} 本，失败 ${failed} 本`,
    items,
    targetPath: targetDir
  }
}

/* ---------------- 邮件配置 ---------------- */

interface MailConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  from: string
  kindleEmail: string
}

function readMailConfig(): { cfg: MailConfig | null; error: string } {
  const store = ctx.settings
  if (!store) return { cfg: null, error: '设置还没初始化' }
  const smtp: SmtpSettings = store.smtp()
  if (!smtp.enabled) return { cfg: null, error: '邮件推送还没启用，请到「设置」页填写 SMTP 信息并打开开关' }
  const host = smtp.host.trim()
  if (!host) return { cfg: null, error: 'SMTP 服务器地址为空' }
  const user = smtp.user.trim()
  if (!user) return { cfg: null, error: 'SMTP 账号为空' }
  const password = store.smtpPassword()
  if (!password) {
    return { cfg: null, error: 'SMTP 授权码还没保存。QQ / 163 邮箱要用「授权码」而不是登录密码。' }
  }
  const kindleEmail = smtp.kindleEmail.trim()
  if (!kindleEmail) return { cfg: null, error: '还没填 Kindle 邮箱（在 Amazon「管理我的内容和设备」里可以看到 xxx@kindle.com）' }
  return {
    cfg: {
      host,
      port: smtp.port || (smtp.secure ? 465 : 587),
      secure: smtp.secure,
      user,
      password,
      from: (smtp.from.trim() || user),
      kindleEmail
    },
    error: ''
  }
}

/* ---------------- 邮件正文 / 附件 ---------------- */

interface Attachment {
  bookId: number
  title: string
  filename: string
  path: string
  mime: string
  size: number
}

/** Amazon 现在只认这三种格式，优先 EPUB */
const ACCEPTED: { format: string; ext: string; mime: string }[] = [
  { format: 'EPUB', ext: '.epub', mime: 'application/epub+zip' },
  { format: 'PDF', ext: '.pdf', mime: 'application/pdf' },
  {
    format: 'DOCX',
    ext: '.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
]

function collectAttachments(
  bookIds: number[]
): { attachments: Attachment[]; failed: DeviceSendItem[] } {
  const attachments: Attachment[] = []
  const failed: DeviceSendItem[] = []
  const lib = ctx.ensureLibrary()
  if (!lib) return { attachments, failed }
  for (const id of bookIds) {
    const book = lib.book(id)
    if (!book) {
      failed.push({ id, title: String(id), ok: false, message: '书库里找不到这本书' })
      continue
    }
    const hit = ACCEPTED.map((candidate) => ({ candidate, file: lib.filePath(id, candidate.format) }))
      .find((entry) => entry.file)
    if (!hit || !hit.file) {
      failed.push({
        id,
        title: book.title,
        ok: false,
        message: `Amazon 只收 EPUB / PDF / DOCX（现有 ${book.formats.join(' / ') || '无格式'}），请先转换`
      })
      continue
    }
    attachments.push({
      bookId: id,
      title: book.title,
      filename: `${safeName(book.title)}${hit.candidate.ext}`,
      path: hit.file,
      mime: hit.candidate.mime,
      size: sizeOf(hit.file)
    })
  }
  return { attachments, failed }
}

/* ---------------- 最小 SMTP 客户端 ---------------- */

type Conn = Socket | TLSSocket

interface Reply {
  code: number
  text: string
}

function heloName(): string {
  const raw = hostname().replace(/[^A-Za-z0-9.-]/g, '-')
  return raw || 'eebookk.local'
}

/** SNI 只接受域名；直接用 IP 连服务器时不能传 servername */
function tlsServerName(host: string): string | undefined {
  return isIP(host) ? undefined : host
}

/** 头部只能放 ASCII；中文主题用 RFC 2047 编码 */
function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ')
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** 附件名：引号里放 ASCII 兜底，中文靠 RFC 2231 的 filename* */
function asciiFallback(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
}

function rfc2231(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/** base64 按 76 列折行，SMTP 对单行长度有硬上限 */
function wrap76(text: string): string {
  const out: string[] = []
  for (let i = 0; i < text.length; i += 76) out.push(text.slice(i, i + 76))
  return out.join('\r\n')
}

function buildMime(msg: {
  from: string
  to: string
  subject: string
  text: string
  attachments: Attachment[]
}): string {
  const boundary = `----eebookk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const lines: string[] = [
    `From: <${msg.from}>`,
    `To: <${msg.to}>`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    '这是一封由 eebookk 发送的邮件。',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(msg.text, 'utf8').toString('base64'))
  ]

  for (const att of msg.attachments) {
    let payload: string
    try {
      payload = readFileSync(att.path).toString('base64')
    } catch {
      continue
    }
    const fallback = asciiFallback(att.filename)
    lines.push(
      '',
      `--${boundary}`,
      `Content-Type: ${att.mime}; name="${fallback}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${rfc2231(att.filename)}`,
      '',
      wrap76(payload)
    )
  }

  lines.push('', `--${boundary}--`, '')
  return lines.join('\r\n')
}

/** 一个连接一个会话；多行应答（250-xxx）拼成一条读出来 */
class SmtpClient {
  private sock: Conn
  private buffer = ''
  private version = 0
  private ended = false
  private failure: Error | null = null
  private waiters: Array<() => void> = []

  constructor(sock: Conn) {
    this.sock = sock
    this.bind(sock)
  }

  private onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('latin1')
    this.version += 1
    this.notify()
  }

  private onError = (e: Error): void => {
    this.failure = e
    this.notify()
  }

  private onClose = (): void => {
    this.ended = true
    this.notify()
  }

  private notify(): void {
    const list = this.waiters
    this.waiters = []
    for (const fn of list) fn()
  }

  private bind(sock: Conn): void {
    sock.on('data', this.onData)
    sock.on('error', this.onError)
    sock.on('close', this.onClose)
    // 服务器长时间不回话就主动断，免得界面一直转圈
    sock.setTimeout(30000, () => this.onError(new Error('SMTP 会话超时')))
  }

  private unbind(sock: Conn): void {
    sock.off('data', this.onData)
    sock.off('error', this.onError)
    sock.off('close', this.onClose)
    sock.setTimeout(0)
  }

  private waitData(): Promise<void> {
    const seen = this.version
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setInterval> | null = null
      const done = (): void => {
        if (timer) clearInterval(timer)
        this.waiters = this.waiters.filter((fn) => fn !== done)
        resolve()
      }
      // 兜底轮询：万一数据在注册监听之前到达，也不会卡死
      timer = setInterval(done, 50)
      this.waiters.push(done)
      if (this.failure || this.ended || this.version !== seen) done()
    })
  }

  /** 读一个完整应答；返回原文（多行用 \n 拼接） */
  async reply(): Promise<Reply> {
    // 多行应答可能分几个 TCP 包到达，已读到的行必须积累在循环外
    const lines: string[] = []
    for (;;) {
      let nl = this.buffer.indexOf('\n')
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, '')
        this.buffer = this.buffer.slice(nl + 1)
        lines.push(line)
        // 「250-xxx」表示后面还有行，「250 xxx」或「250」才是最后一行
        if (/^\d{3}(?: |$)/.test(line)) {
          const raw = lines.join('\n')
          return { code: Number(raw.slice(0, 3)), text: raw }
        }
        nl = this.buffer.indexOf('\n')
      }
      if (this.failure) throw this.failure
      if (this.ended) throw new Error('SMTP 连接已被服务器关闭')
      await this.waitData()
    }
  }

  async expect(codes: number[]): Promise<Reply> {
    const reply = await this.reply()
    if (!codes.includes(reply.code)) {
      throw new Error(`SMTP ${reply.code}：${reply.text.replace(/\s+/g, ' ').trim()}`)
    }
    return reply
  }

  async send(line: string, codes: number[]): Promise<Reply> {
    this.sock.write(`${line}\r\n`)
    return this.expect(codes)
  }

  async sendRaw(data: string, codes: number[]): Promise<Reply> {
    this.sock.write(data)
    return this.expect(codes)
  }

  /** EHLO 的应答里带服务器能力（STARTTLS / AUTH ...），原样交给调用方判断 */
  async ehlo(): Promise<string> {
    return (await this.send(`EHLO ${heloName()}`, [250])).text
  }

  async auth(caps: string, user: string, password: string): Promise<void> {
    if (!user) return
    const authLine = caps
      .split('\n')
      .map((line) => line.slice(4).trim())
      .find((line) => /^AUTH\b/i.test(line))
    const methods = authLine ? authLine.split(/\s+/).slice(1).map((m) => m.toUpperCase()) : []
    if (methods.includes('PLAIN') && !methods.includes('LOGIN')) {
      const token = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64')
      await this.send(`AUTH PLAIN ${token}`, [235])
      return
    }
    // QQ / 163 都支持 AUTH LOGIN
    await this.send('AUTH LOGIN', [334])
    await this.send(Buffer.from(user, 'utf8').toString('base64'), [334])
    await this.send(Buffer.from(password, 'utf8').toString('base64'), [235])
  }

  /** 把明文连接升级成 TLS，之后复用同一个 SmtpClient */
  async startTls(host: string): Promise<void> {
    const raw = this.sock
    this.unbind(raw)
    raw.on('error', () => {
      /* 升级后错误统一由 TLS socket 抛出，这里只是防止 unhandled error */
    })
    const secured = await new Promise<TLSSocket>((resolve, reject) => {
      const tls = tlsConnect({ socket: raw, servername: tlsServerName(host) })
      tls.once('secureConnect', () => resolve(tls))
      tls.once('error', (e: Error) => reject(new Error(`STARTTLS 握手失败：${e.message}`)))
    })
    this.sock = secured
    this.buffer = ''
    this.version = 0
    this.bind(secured)
  }

  close(): void {
    const sock = this.sock
    this.unbind(sock)
    sock.on('error', () => {
      /* 关闭过程中的错误不用管 */
    })
    try {
      sock.end()
    } catch {
      /* 已经断开 */
    }
    try {
      sock.destroy()
    } catch {
      /* 已经断开 */
    }
  }
}

function openSocket(host: string, port: number, secure: boolean): Promise<Conn> {
  return new Promise<Conn>((resolve, reject) => {
    const sock: Conn = secure
      ? tlsConnect({ host, port, servername: tlsServerName(host) })
      : netConnect({ host, port })
    let timer: ReturnType<typeof setTimeout> | null = null
    const fail = (e: Error): void => {
      if (timer) clearTimeout(timer)
      sock.destroy()
      reject(new Error(`连接 ${host}:${port} 失败：${e.message}`))
    }
    timer = setTimeout(() => fail(new Error('连接超时')), 20000)
    // error 监听保留到连接建立之后：出错时直接把 socket 收掉，交给会话层报错
    sock.on('error', fail)
    const ready = (): void => {
      if (timer) clearTimeout(timer)
      resolve(sock)
    }
    if (secure) (sock as TLSSocket).once('secureConnect', ready)
    else sock.once('connect', ready)
  })
}

/** 完整的一次投递：TCP → (STARTTLS) → AUTH → MAIL/RCPT/DATA → QUIT */
async function smtpSend(msg: {
  cfg: MailConfig
  to: string
  subject: string
  text: string
  attachments: Attachment[]
}): Promise<void> {
  const { cfg } = msg
  const body = buildMime({
    from: cfg.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    attachments: msg.attachments
  }).replace(/^\./gm, '..') // DATA 阶段的行首点号要转义

  const sock = await openSocket(cfg.host, cfg.port, cfg.secure)
  const client = new SmtpClient(sock)
  try {
    await client.expect([220])
    let caps = await client.ehlo()

    if (!cfg.secure) {
      if (!/\bSTARTTLS\b/i.test(caps)) {
        throw new Error('服务器不支持 STARTTLS，为避免明文传授权码已中止')
      }
      await client.send('STARTTLS', [220])
      await client.startTls(cfg.host)
      caps = await client.ehlo()
    }

    await client.auth(caps, cfg.user, cfg.password)
    await client.send(`MAIL FROM:<${cfg.from}>`, [250])
    await client.send(`RCPT TO:<${msg.to}>`, [250, 251])
    await client.send('DATA', [354])
    await client.sendRaw(`${body}.\r\n`, [250])
    try {
      await client.send('QUIT', [221])
    } catch {
      /* 邮件已经投递成功了，QUIT 失败不影响结果 */
    }
  } finally {
    client.close()
  }
}

/* ---------------- 邮件推送 ---------------- */

export async function pushByEmail(payload: DeviceSendPayload): Promise<DeviceSendResult> {
  const items: DeviceSendItem[] = []
  if (!payload.bookIds.length) return { ok: false, message: '还没有选书', items }
  if (!ctx.ensureLibrary()) return { ok: false, message: '书库未就绪', items }

  const { cfg, error } = readMailConfig()
  if (!cfg) return { ok: false, message: error, items }

  const { attachments, failed } = collectAttachments(payload.bookIds)
  items.push(...failed)
  if (!attachments.length) {
    return { ok: false, message: '没有可推送的附件（需要 EPUB / PDF / DOCX）', items }
  }

  const limitMB = Math.round(maxMailBytes() / (1024 * 1024))
  const tooBig = attachments.find((att) => att.size > maxMailBytes())
  if (tooBig) {
    for (const att of attachments) {
      items.push({
        id: att.bookId,
        title: att.title,
        ok: false,
        message: att.size > maxMailBytes() ? `附件 ${formatBytes(att.size)} 超过单封 ${limitMB} MB 上限` : '同批里有过大的附件，已整批取消'
      })
    }
    return {
      ok: false,
      message: `《${tooBig.title}》附件 ${formatBytes(tooBig.size)}，超过单封 ${limitMB} MB 上限，请拆分或压缩后再推送`,
      items
    }
  }

  const total = attachments.reduce((sum, att) => sum + att.size, 0)
  if (total > maxMailBytes()) {
    for (const att of attachments) {
      items.push({ id: att.bookId, title: att.title, ok: false, message: `同批附件合计超过 ${limitMB} MB` })
    }
    return {
      ok: false,
      message: `附件合计 ${formatBytes(total)}，超过单封 ${limitMB} MB 上限，请分几次推送`,
      items
    }
  }

  const subject =
    payload.subject?.trim() ||
    (attachments.length === 1 ? `推送《${attachments[0].title}》` : `推送 ${attachments.length} 本书`)
  const text = [
    '这是通过 eebookk 推送到 Kindle 的书籍：',
    ...attachments.map((att, index) => `${index + 1}. ${att.title}`),
    '',
    '如果没有在设备上出现，请确认：',
    '- 已把发件邮箱加入 Amazon「已批准的个人文档邮箱列表」；',
    '- 设备已连 WiFi，且几分钟后再同步一次。'
  ].join('\n')

  try {
    await smtpSend({ cfg, to: cfg.kindleEmail, subject, text, attachments })
  } catch (e) {
    const message = (e as Error).message || '邮件发送失败'
    for (const att of attachments) {
      items.push({ id: att.bookId, title: att.title, ok: false, message })
    }
    return { ok: false, message, items }
  }

  for (const att of attachments) {
    items.push({ id: att.bookId, title: att.title, ok: true, message: `已发送到 ${cfg.kindleEmail}` })
  }
  return {
    ok: true,
    message: `已发送 ${attachments.length} 本到 Kindle 邮箱 ${cfg.kindleEmail}，通常 5 分钟内在设备上出现`,
    items
  }
}

/** 测试按钮：发一封没有附件的信到发件账号自己，验证账号 / 授权码是否正确 */
export async function testSmtp(): Promise<SendResult> {
  const { cfg, error } = readMailConfig()
  if (!cfg) return { ok: false, message: error }
  const to = cfg.from || cfg.user
  try {
    await smtpSend({
      cfg,
      to,
      subject: 'eebookk SMTP 测试',
      text: '这是一封来自 eebookk 的测试邮件。\n收到它说明 SMTP 服务器、账号、授权码和发件人都配置正确。',
      attachments: []
    })
    return { ok: true, message: `测试邮件已发送到 ${to}` }
  } catch (e) {
    return { ok: false, message: (e as Error).message || '发送失败' }
  }
}

/* ---------------- 注册 ---------------- */

export function registerDevice(): void {
  // settings:get / settings:set 已在 index.ts 注册，这里只加设备与推送这三个频道，避免重复注册
  ipcMain.handle(CH.deviceDetect, (_e, force?: boolean) => detectKindle(Boolean(force)))

  ipcMain.handle(CH.deviceSend, async (_e, raw: unknown) => {
    const payload = normalizePayload(raw)
    try {
      return payload.mode === 'email' ? await pushByEmail(payload) : await pushToDevice(payload)
    } catch (e) {
      return { ok: false, message: (e as Error).message || '推送失败', items: [] } as DeviceSendResult
    }
  })

  ipcMain.handle(CH.smtpTest, () => testSmtp())
}
