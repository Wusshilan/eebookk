import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 主进程结构化日志：控制台 + userData/logs/app.log。
 *
 * 两个必须防的坑：
 *  1. 重入。console.error 在 stdout 已关闭时会抛 EPIPE，而 uncaughtException 的处理器
 *     又会调 logger → 再抛 → 再进处理器，无限递归且疯狂写盘。
 *  2. stdout 本身不可用。打包后没有控制台，写 console 可能抛错，不能让它影响落盘。
 */

let dir = ''
let file = ''
const MAX_BYTES = 2 * 1024 * 1024
/** 重入闸门：日志函数内部任何一步再抛错都不允许回到自己 */
let inLog = false

function ensurePaths(): void {
  if (file) return
  dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'app.log')
}

function serialize(extra: unknown): string {
  if (extra === undefined) return ''
  if (extra instanceof Error) return ` ${extra.name}: ${extra.message}\n${extra.stack ?? ''}`
  try {
    return ` ${JSON.stringify(extra)}`
  } catch {
    return ` ${String(extra)}`
  }
}

function writeConsole(level: 'info' | 'warn' | 'error', line: string): void {
  try {
    if (level === 'error') console.error(line)
    else console.log(line)
  } catch {
    /* stdout 关了（EPIPE / 已销毁），忽略 */
  }
}

export function log(level: 'info' | 'warn' | 'error', message: string, extra?: unknown): void {
  if (inLog) return
  inLog = true
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${message}${serialize(extra)}`
    writeConsole(level, line)
    try {
      ensurePaths()
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, join(dir, `app-${Date.now()}.log`))
      } catch {
        /* 第一次写，文件还不存在 */
      }
      appendFileSync(file, `${line}\n`, 'utf8')
    } catch {
      /* 磁盘只读 / 目录不可写，不影响主流程 */
    }
  } catch {
    /* 兜底：日志本身绝不能把进程带走 */
  } finally {
    inLog = false
  }
}

export const logger = {
  info: (m: string, e?: unknown) => log('info', m, e),
  warn: (m: string, e?: unknown) => log('warn', m, e),
  error: (m: string, e?: unknown) => log('error', m, e)
}

/** 装到进程级别；未捕获的异常记一笔后继续，不让它变成长任务挂死 */
export function installProcessHandlers(): void {
  process.on('uncaughtException', (e) => {
    log('error', 'uncaughtException', e)
  })
  process.on('unhandledRejection', (e) => {
    log('error', 'unhandledRejection', e)
  })
  // stdout/stderr 被提前关闭时（比如以分离进程启动）不要抛 EPIPE
  process.stdout.on('error', () => undefined)
  process.stderr.on('error', () => undefined)
}
