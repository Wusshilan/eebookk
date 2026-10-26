import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defaultLibraryPath, detectLibraryPath } from './calibre'
import { ctx } from './ctx'
import { bundledCalibreBase, calibreExe, probeCalibreVersion } from './env'
import { logger } from './logger'

const run = promisify(execFile)

/**
 * 启动准备：探测 calibre 版本，并处理「第一次打开还没有书库」。
 *
 * 内置 calibre 的版本里，用户不需要先跑一遍 calibre GUI：
 * calibredb 打开一个没有 metadata.db 的目录时会把空书库建出来（实测 calibre 9.15），
 * 默认位置和 calibre 自己一致（~\\Calibre 书库）。之后用户也可以随时在设置里改路径。
 */
export async function prepareCalibre(): Promise<void> {
  const version = await probeCalibreVersion()
  const bundled = bundledCalibreBase()
  logger.info('calibre 引擎', {
    bundled: bundled ?? '(未内置)',
    version,
    calibredb: calibreExe('calibredb')
  })

  if (!bundled) return

  const settings = ctx.settings
  const configured = settings?.get().libraryPath
  if (configured && existsSync(join(configured, 'metadata.db'))) return

  const found = detectLibraryPath()
  if (found) {
    settings?.update({ libraryPath: found })
    return
  }

  const target = defaultLibraryPath()
  try {
    mkdirSync(target, { recursive: true })
    await run(calibreExe('calibredb'), ['list', '--with-library', target], { windowsHide: true })
    if (existsSync(join(target, 'metadata.db'))) {
      settings?.update({ libraryPath: target })
      logger.info('已建立空书库', { path: target })
    }
  } catch (e) {
    logger.warn('自动建立书库失败', e)
  }
}
