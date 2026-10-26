import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'

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
  | 'calibre'
  | 'calibre-debug'
  | 'calibre-parallel'

/**
 * 随应用一起分发的 calibre（「内置 calibre」版本）。
 *
 * 目录约定：
 *  - 打包后：`<安装目录>\resources\calibre`（electron-builder extraResources）
 *  - 开发时：`<仓库>\vendor\calibre`
 *  - 调试时可以拿 `EEBOOKK_CALIBRE_DIR` 指向任意一份 calibre 安装目录
 *
 * 内置版本优先于系统安装的 calibre：同一份引擎，行为可预期，
 * 用户机器上没装 calibre 也能跑。
 */
export function bundledCalibreBase(): string | null {
  const override = process.env.EEBOOKK_CALIBRE_DIR
  if (override && existsSync(join(override, 'calibredb.exe'))) return override
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'calibre')
    : join(app.getAppPath(), 'vendor', 'calibre')
  return existsSync(join(dir, 'calibredb.exe')) ? dir : null
}

export function isBundledCalibre(): boolean {
  return bundledCalibreBase() !== null
}

/** 找 calibre 的命令行工具：内置优先，其次系统安装目录，最后交给 PATH */
export function calibreExe(name: CalibreTool): string {
  const bundled = bundledCalibreBase()
  if (bundled) return join(bundled, `${name}.exe`)
  for (const base of CANDIDATE_BASES) {
    const p = join(base, `${name}.exe`)
    if (existsSync(p)) return p
  }
  return name
}

/** 主程序 calibre.exe 的绝对路径；找不到返回 null */
export function calibreGuiExe(): string | null {
  const exe = calibreExe('calibre')
  if (!exe.includes('\\') && !exe.includes('/')) return null
  return existsSync(exe) ? exe : null
}

/** 启动时探测一次版本，供书库 payload 显示 */
let versionLabel: string | null = null

export async function probeCalibreVersion(): Promise<string | null> {
  if (versionLabel) return versionLabel
  const bundled = bundledCalibreBase() !== null
  const anySystem = CANDIDATE_BASES.some((b) => existsSync(join(b, 'calibredb.exe')))
  // 既没内置也没装：不白跑一次进程
  if (!bundled && !anySystem) return null
  try {
    const { stdout } = await run(calibreExe('calibredb'), ['--version'], { windowsHide: true })
    const m = /calibre\s+([\d.]+)/i.exec(stdout)
    versionLabel = m ? `${bundled ? '内置' : '系统'} calibre ${m[1]}` : bundled ? '内置 calibre' : '系统 calibre'
  } catch {
    /* 探测失败就保持 null，界面显示「未检测到」 */
  }
  return versionLabel
}

export function calibreVersionLabel(): string | null {
  return versionLabel
}
