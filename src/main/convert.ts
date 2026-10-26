import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { extname, join } from 'node:path'
import { app, ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import type { Book, ConvertJob, TaskSnapshot } from '../shared/types'
import { ctx } from './ctx'
import { calibreExe } from './env'
import { writeFileAtomic } from './file-utils'

/**
 * 转换后端：把 calibre 的 ebook-convert 当引擎，自己维护队列。
 *
 * 关键事实（已在本机 calibre 9.15.0 验证）：
 *  - `ebook-convert <in> <out> --verbose` 不需要书库锁，calibre 开着也能跑
 *  - 进度在 **stdout**，形如：`1% 转换为HTML中...` / `34% 正在进行电子书转换...`
 *    正则：/^(\d+)%\s+(.*)$/，按行增量解析
 *  - 实测 100KB 的 epub → mobi 约 3 秒
 */

/** 可选输出格式：ebook-convert 靠输出文件的扩展名决定目标格式 */
export const TARGETS = ['epub', 'mobi', 'azw3', 'pdf', 'txt'] as const
export type TargetFormat = (typeof TARGETS)[number]

/** 并发数见下方 concurrency()，从设置里读 */
/** 进度事件节流，200ms 一次足够顺滑 */
const EMIT_MS = 200

export interface EnqueueResult {
  ok: boolean
  added: number
  skipped: number
  message?: string
}

export interface ActionResult {
  ok: boolean
  message?: string
}

interface JobRuntime {
  child: import('node:child_process').ChildProcess
  /** 输出文件绝对路径（成功才登记回任务） */
  output: string
  /** stdout 半行缓冲 */
  buffer: string
  /** stderr 尾部，失败时当原因 */
  stderr: string
  /** 只结算一次：error / close / 取消 可能都触发 */
  settled: boolean
}

const jobs: ConvertJob[] = []
const running = new Map<string, JobRuntime>()
let seq = 0
let emitTimer: ReturnType<typeof setTimeout> | null = null

/* ---------------- 队列持久化 ---------------- */

function storeFile(): string {
  return join(app.getPath('userData'), 'convert-jobs.json')
}

function saveJobs(): void {
  try {
    // 只留最近 200 条，别让文件无限长
    writeFileAtomic(storeFile(), JSON.stringify(jobs.slice(-200), null, 2))
  } catch {
    /* 写不了就保持内存态，不影响使用 */
  }
}

/** 启动时恢复历史任务；上次没跑完的（running/queued）标记为中断 */
export function loadJobs(): void {
  try {
    const raw = readFileSync(storeFile(), 'utf8')
    const list = JSON.parse(raw) as ConvertJob[]
    if (!Array.isArray(list)) return
    for (const j of list) {
      if (!j || typeof j.id !== 'string') continue
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'failed'
        j.message = '应用重启，任务已中断'
        j.finishedAt = j.finishedAt ?? Date.now()
      }
      jobs.push(j)
    }
  } catch {
    /* 首次运行或文件损坏：从空队列开始 */
  }
}

/* ---------------- 输出路径 ---------------- */

function outputDir(): string {
  // 「设置 → 转换 → 输出目录」优先；留空则落到 userData/exports
  const custom = ctx.settings?.get().convert.outputDir?.trim()
  const dir = custom && custom.length > 0 ? custom : join(app.getPath('userData'), 'exports')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 并发数来自设置，1–4，默认 2 */
function concurrency(): number {
  const raw = Number(ctx.settings?.get().convert.concurrency ?? 2)
  if (!Number.isFinite(raw)) return 2
  return Math.max(1, Math.min(4, Math.round(raw)))
}

/** Windows 文件名不能带这些字符，顺手裁到 80 字 */
function safeName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || '未命名'
}

/** 同名文件不覆盖，依次加 (2) (3) */
function freshOutputPath(title: string, ext: string): string {
  const dir = outputDir()
  const base = safeName(title)
  let candidate = join(dir, `${base}.${ext}`)
  let i = 2
  while (existsSync(candidate) && i <= 200) {
    candidate = join(dir, `${base} (${i}).${ext}`)
    i += 1
  }
  return candidate
}

/* ---------------- 快照 / 事件 ---------------- */

/** 当前队列副本，给别的模块或 IPC 用 */
export function convertSnapshot(): ConvertJob[] {
  return jobs.map((job) => ({ ...job }))
}

/** 最近在读：posFrac 最大的那本，供底部常驻条用 */
function readingNow(): TaskSnapshot['reading'] {
  const lib = ctx.ensureLibrary()
  if (!lib) return null
  let best: Book | null = null
  for (const book of lib.all()) {
    if (book.posFrac == null) continue
    const beat =
      !best ||
      book.posFrac > (best.posFrac ?? 0) ||
      (book.posFrac === best.posFrac && (book.readEpoch ?? 0) > (best.readEpoch ?? 0))
    if (beat) best = book
  }
  if (!best) return null
  return {
    bookId: best.id,
    title: best.title,
    posFrac: best.posFrac,
    at: (best.readEpoch ?? 0) * 1000
  }
}

export function snapshot(): TaskSnapshot {
  return { converts: convertSnapshot(), reading: readingNow() }
}

function emitNow(): void {
  saveJobs()
  ctx.emit(CH.evtTasks, snapshot())
}

function pushThrottled(): void {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    emitNow()
  }, EMIT_MS)
}

/* ---------------- 进度解析 ---------------- */

function feedProgress(job: ConvertJob, rt: JobRuntime, chunk: string): void {
  if (job.status !== 'running') return
  rt.buffer += chunk
  const parts = rt.buffer.split(/\r\n|\n|\r/)
  rt.buffer = parts.pop() ?? ''
  for (const raw of parts) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim()
    if (!line) continue
    const match = line.match(/^(\d+)%\s+(.*)$/)
    if (!match) continue
    const percent = Math.max(0, Math.min(100, Number(match[1])))
    const stage = match[2].trim()
    if (percent === job.percent && stage === job.stage) continue
    job.percent = percent
    job.stage = stage
    pushThrottled()
  }
}

function failureText(code: number | null, stderr: string): string {
  const lines = stderr
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const tail = lines.slice(-2).join(' ').slice(0, 300)
  if (tail) return tail
  return code == null ? '转换进程被终止' : `ebook-convert 退出码 ${code}`
}

/* ---------------- 进程控制 ---------------- */

/** 取消时连子进程一起收掉，否则 py 子进程会留在后台继续写文件 */
function killTree(child: import('node:child_process').ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    return
  }
  child.kill('SIGTERM')
}

/** settings 里的额外参数，按空格切分（不支持带空格的参数） */
function extraArgs(): string[] {
  const raw = ctx.settings?.get().convert.extraArgs ?? ''
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function normalizeTarget(value: string | null | undefined): TargetFormat {
  const target = (value ?? 'epub').toLowerCase().trim()
  return (TARGETS as readonly string[]).includes(target) ? (target as TargetFormat) : 'epub'
}

/* ---------------- 队列调度 ---------------- */

function start(job: ConvertJob): void {
  const lib = ctx.ensureLibrary()
  const input = lib?.filePath(job.bookId) ?? null
  if (!input) {
    job.status = 'failed'
    job.stage = '失败'
    job.message = '找不到源文件（书可能已被移动或删除）'
    job.finishedAt = Date.now()
    return
  }

  job.status = 'running'
  job.percent = 0
  job.stage = '启动中'
  job.startedAt = Date.now()

  const output = freshOutputPath(job.title, job.to)
  const child = spawn(
    calibreExe('ebook-convert'),
    [
      input,
      output,
      '--verbose',
      ...(ctx.settings?.get().convert.outputProfile
        ? ['--output-profile', ctx.settings.get().convert.outputProfile]
        : []),
      ...extraArgs()
    ],
    { windowsHide: true }
  )
  const rt: JobRuntime = { child, output, buffer: '', stderr: '', settled: false }
  running.set(job.id, rt)

  const settle = (status: 'done' | 'failed', message?: string): void => {
    if (rt.settled) return
    rt.settled = true
    running.delete(job.id)
    job.finishedAt = Date.now()
    if (status === 'done') {
      job.status = 'done'
      job.percent = 100
      job.stage = '完成'
      job.outputPath = rt.output
      delete job.message
    } else {
      job.status = 'failed'
      job.stage = '失败'
      job.message = message ?? '转换失败'
      // 失败留下的半成品清掉，免得 exports 里越积越多
      if (existsSync(rt.output)) {
        try {
          unlinkSync(rt.output)
        } catch {
          /* 文件被占用时删不掉，不影响任务状态 */
        }
      }
    }
    emitNow()
    pump()
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => feedProgress(job, rt, chunk))

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    rt.stderr = (rt.stderr + chunk).slice(-4000)
  })

  child.on('error', (e: Error) => settle('failed', `无法启动 ebook-convert：${e.message}`))

  child.on('close', (code: number | null) => {
    if (rt.settled) {
      running.delete(job.id)
      return
    }
    if (code === 0 && existsSync(rt.output)) settle('done')
    else if (code === 0) settle('failed', '转换进程结束了，但没找到输出文件')
    else settle('failed', failureText(code, rt.stderr))
  })
}

function pump(): void {
  let started = false
  while (running.size < concurrency()) {
    const next = jobs.find((job) => job.status === 'queued')
    if (!next) break
    start(next)
    started = true
  }
  if (started) emitNow()
}

/* ---------------- 对外动作 ---------------- */

export function enqueue(bookIds: number[], target?: string): EnqueueResult {
  const lib = ctx.ensureLibrary()
  if (!lib) return { ok: false, added: 0, skipped: 0, message: '书库未就绪，无法转换' }
  const ids = Array.isArray(bookIds) ? bookIds.filter((id) => Number.isFinite(id)) : []
  if (!ids.length) return { ok: false, added: 0, skipped: 0, message: '没有选中任何书' }

  const to = normalizeTarget(target ?? ctx.settings?.get().convert.defaultTarget)
  let added = 0
  let skipped = 0

  for (const bookId of ids) {
    const book = lib.book(bookId)
    if (!book) {
      skipped += 1
      continue
    }
    // 同一本书同一个目标格式已经在排队/转换中就不重复入队
    const busy = jobs.some(
      (job) =>
        job.bookId === bookId &&
        job.to === to &&
        (job.status === 'queued' || job.status === 'running')
    )
    const input = lib.filePath(bookId)
    if (busy || !input) {
      skipped += 1
      continue
    }
    seq += 1
    jobs.push({
      id: `cv-${Date.now().toString(36)}-${seq}`,
      bookId,
      title: book.title,
      from: extname(input).replace(/^\./, '').toUpperCase() || book.formats[0] || '?',
      to,
      status: 'queued',
      percent: 0,
      stage: '排队中',
      createdAt: Date.now()
    })
    added += 1
  }

  emitNow()
  pump()
  return {
    ok: added > 0,
    added,
    skipped,
    message: added > 0 ? undefined : '没有可入队的书（找不到源文件，或已在队列里）'
  }
}

export function cancel(jobId: string): ActionResult {
  const job = jobs.find((item) => item.id === jobId)
  if (!job) return { ok: false, message: '任务不存在' }

  if (job.status === 'queued') {
    job.status = 'canceled'
    job.stage = '已取消'
    job.finishedAt = Date.now()
    emitNow()
    return { ok: true }
  }

  if (job.status === 'running') {
    const rt = running.get(jobId)
    job.status = 'canceled'
    job.stage = '已取消'
    job.finishedAt = Date.now()
    if (rt) {
      // 先标记已结算并让出并发位，再杀进程（close 事件随后会看到 settled）
      rt.settled = true
      running.delete(jobId)
      killTree(rt.child)
    }
    emitNow()
    pump()
    return { ok: true }
  }

  return { ok: false, message: '任务已经结束' }
}

export function clearFinished(): { ok: boolean; removed: number } {
  let removed = 0
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const status = jobs[i].status
    if (status === 'done' || status === 'failed' || status === 'canceled') {
      jobs.splice(i, 1)
      removed += 1
    }
  }
  if (removed) emitNow()
  return { ok: true, removed }
}

/* ---------------- 注册 ---------------- */

export function registerConvert(): void {
  loadJobs()
  ipcMain.handle(CH.convertEnqueue, (_e, bookIds: number[], target?: string) =>
    enqueue(bookIds, target)
  )
  ipcMain.handle(CH.convertCancel, (_e, jobId: string) => cancel(jobId))
  ipcMain.handle(CH.convertClearFinished, () => clearFinished())
  ipcMain.handle(CH.convertList, () => snapshot())

  // 退出前把还在跑的转换收掉，别在后台留孤儿进程
  app.on('before-quit', () => {
    for (const [id, rt] of running) {
      rt.settled = true
      killTree(rt.child)
      running.delete(id)
    }
  })
}
