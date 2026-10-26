import type { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectLibraryPath, Library } from './calibre'
import type { LibraryPayload } from '../shared/types'
import type { SettingsStore } from './settings'

/**
 * 主进程共享上下文。各 IPC 模块通过它拿书库、拿窗口、推事件，
 * 避免模块之间互相 import 造成循环依赖。
 */
class MainContext {
  window: BrowserWindow | null = null
  settings: SettingsStore | null = null
  library: Library | null = null
  /** calibre 主程序是否在运行；true 时 calibredb 会拒绝一切写入 */
  calibreRunning = false

  ensureLibrary(): Library | null {
    if (this.library?.isReady) return this.library
    const root = this.settings?.get().libraryPath ?? detectLibraryPath()
    if (!root) return null
    if (!existsSync(join(root, 'metadata.db'))) return null
    this.library = new Library(root)
    this.library.read()
    return this.library
  }

  reload(): LibraryPayload {
    const lib = this.ensureLibrary()
    if (lib) lib.read()
    return this.payload()
  }

  payload(): LibraryPayload {
    const lib = this.ensureLibrary()
    if (!lib) {
      return {
        path: '',
        calibreVersion: null,
        calibreRunning: this.calibreRunning,
        stats: {
          total: 0, withDesc: 0, withTags: 0, withSeries: 0, withRating: 0,
          withCover: 0, withIdentifier: 0, epub: 0, started: 0,
          tags: 0, authors: 0, series: 0, publishers: 0
        },
        books: []
      }
    }
    return lib.payload(this.calibreRunning)
  }

  /** 主进程 -> 渲染进程 */
  emit(channel: string, ...args: unknown[]): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args)
    }
  }
}

export const ctx = new MainContext()
