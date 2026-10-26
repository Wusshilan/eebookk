import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** calibre 主程序是否在运行 —— 在运行期间 calibredb 拒绝一切写入，包括只读 list */
export async function isCalibreRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq calibre.exe', '/NH'], {
      windowsHide: true
    })
    return /calibre\.exe/i.test(stdout)
  } catch {
    return false
  }
}

/**
 * 请求 calibre 退出：先发正常关闭（WM_CLOSE），不硬杀，用户数据不会丢。
 * 不返回是否成功——调用方应重新轮询 isCalibreRunning。
 */
export async function requestCloseCalibre(): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await run('taskkill', ['/IM', 'calibre.exe'], { windowsHide: true })
  } catch {
    /* 进程不存在时 taskkill 会非零退出，忽略 */
  }
}

const CANDIDATE_BASES = [
  process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Calibre2` : '',
  'C:\\Program Files\\Calibre2',
  'C:\\Program Files (x86)\\Calibre2'
].filter(Boolean)

/** calibre 的命令行工具 */
export type CalibreTool =
  | 'calibredb'
  | 'ebook-convert'
  | 'ebook-viewer'
  | 'ebook-meta'
  | 'ebook-edit'
  | 'ebook-polish'
  | 'fetch-ebook-metadata'

/** 找 calibre 的命令行工具；找不到就返回裸名字，交给 PATH */
export function calibreExe(name: CalibreTool): string {
  for (const base of CANDIDATE_BASES) {
    const p = `${base}\\${name}.exe`
    if (existsSync(p)) return p
  }
  return name
}
