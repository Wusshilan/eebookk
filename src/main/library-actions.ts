import { execFile, spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, ipcMain, shell } from 'electron'
import { promisify } from 'node:util'
import { CH } from '../shared/ipc'
import { ctx } from './ctx'
import { calibreExe, isCalibreRunning } from './env'

const run = promisify(execFile)

async function calibredb(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  // 每次现查，别用缓存：calibre 可能刚好在上一次轮询之后启动
  ctx.calibreRunning = await isCalibreRunning()
  if (ctx.calibreRunning) {
    return {
      ok: false,
      out: '',
      err: 'calibre 正在运行，calibredb 会拒绝执行。请先关闭 calibre。'
    }
  }
  const lib = ctx.ensureLibrary()
  if (!lib) return { ok: false, out: '', err: '书库未就绪' }
  try {
    const { stdout, stderr } = await run(
      calibreExe('calibredb'),
      [...args, '--with-library', lib.root],
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    )
    return { ok: true, out: stdout, err: stderr }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: err.stdout ?? '', err: err.stderr ?? err.message ?? '未知错误' }
  }
}

export function registerLibraryActions(): void {
  ipcMain.handle(CH.libraryRevealBook, (_e, id: number) => {
    const file = ctx.library?.filePath(id)
    if (!file) return { ok: false, message: '找不到文件' }
    shell.showItemInFolder(file)
    return { ok: true, message: '' }
  })

  ipcMain.handle(CH.libraryRemove, async (_e, ids: number[]) => {
    if (!ids?.length) return { ok: true, removed: 0 }
    const lib = ctx.ensureLibrary()

    // 先复制一份到回收目录再删：calibredb remove 会直接删文件，误删无法挽回
    let trashPath = ''
    if (lib) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      trashPath = join(app.getPath('userData'), 'trash', stamp)
      for (const id of ids) {
        const book = lib.book(id)
        if (!book) continue
        try {
          cpSync(join(lib.root, book.relPath), join(trashPath, book.relPath), { recursive: true })
        } catch {
          /* 个别书复制失败不阻塞删除，至少把能救的救下来 */
        }
      }
    }

    const res = await calibredb(['remove', ...ids.map(String)])
    if (!res.ok) return { ok: false, removed: 0, message: res.err }
    ctx.reload()
    return {
      ok: true,
      removed: ids.length,
      message: trashPath
        ? `已删除 ${ids.length} 本；文件已备份到 ${trashPath}`
        : `已删除 ${ids.length} 本`
    }
  })

  ipcMain.handle(CH.libraryAdd, async (_e, incoming?: string[]) => {
    let files = incoming ?? []
    if (!files.length) {
      // 没带文件就弹选择框；渲染层只负责显示结果
      const pick = await dialog.showOpenDialog({
        title: '添加书籍到书库',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '电子书', extensions: ['epub', 'pdf', 'mobi', 'azw3', 'azw', 'fb2', 'txt', 'docx', 'html', 'rtf'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      if (pick.canceled || !pick.filePaths.length) return { ok: false, added: 0, message: '已取消' }
      files = pick.filePaths
    }
    const res = await calibredb(['add', ...files])
    if (!res.ok) return { ok: false, added: 0, message: res.err }
    ctx.reload()
    const ids = res.out.match(/\d+/g)
    return {
      ok: true,
      added: ids ? ids.length : files.length,
      message: res.out.trim() || `已添加 ${files.length} 个文件`
    }
  })

  /** 用 calibre 的电子书编辑器打开这本书（独立进程，不阻塞主界面） */
  ipcMain.handle(CH.bookEdit, (_e, id: number) => {
    const file = ctx.library?.filePath(id)
    if (!file) return { ok: false, message: '找不到这本书的文件' }
    spawn(calibreExe('ebook-edit'), [file], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return { ok: true, message: '已启动电子书编辑器' }
  })

  /**
   * 打磨：ebook-polish 原地处理。默认做两件最安全的事——把元数据和封面嵌进文件、
   * 压缩图片。不重新排版，不动正文。
   */
  ipcMain.handle(CH.bookPolish, async (_e, id: number) => {
    const file = ctx.library?.filePath(id)
    if (!file) return { ok: false, message: '找不到这本书的文件' }
    try {
      await run(
        calibreExe('ebook-polish'),
        ['--embed-metadata', '--compress-images', file],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
      )
      return { ok: true, message: '已打磨：元数据与封面已嵌入文件、图片已压缩' }
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      return { ok: false, message: err.stderr?.trim() || err.message || '打磨失败' }
    }
  })

  /** 把 calibre 库里的元数据/封面写回书籍文件本身 */
  ipcMain.handle(CH.bookEmbed, async (_e, id: number) => {
    const res = await calibredb(['embed_metadata', String(id)])
    return { ok: res.ok, message: res.ok ? (res.out.trim() || '已嵌入') : res.err }
  })

  /** 导出到用户选的文件夹 */
  ipcMain.handle(CH.bookExport, async (_e, ids: number[]) => {
    if (!ids?.length) return { ok: false, message: '没有选中书籍' }
    const pick = await dialog.showOpenDialog({
      title: '导出到这个文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (pick.canceled || !pick.filePaths.length) return { ok: false, message: '已取消' }
    const res = await calibredb(['export', ...ids.map(String), '--to-dir', pick.filePaths[0]])
    return {
      ok: res.ok,
      message: res.ok ? `已导出 ${ids.length} 本到 ${pick.filePaths[0]}` : res.err
    }
  })

  /** 备份 metadata.db 到 userData/backups，写库前的保险 */
  ipcMain.handle(CH.libraryBackup, () => {
    const lib = ctx.ensureLibrary()
    if (!lib?.isReady) return { ok: false, message: '书库未就绪' }
    try {
      const dir = join(app.getPath('userData'), 'backups')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const target = join(dir, `metadata-${stamp}.db`)
      copyFileSync(lib.dbFile, target)
      return { ok: true, message: `已备份到 ${target}`, path: target }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '备份失败' }
    }
  })

  /** 打开 calibre 主程序 */
  ipcMain.handle(CH.openCalibre, () => {
    const lib = ctx.ensureLibrary()
    const exe = calibreExe('calibredb').replace(/calibredb\.exe$/i, 'calibre.exe')
    if (!existsSync(exe)) return { ok: false, message: '找不到 calibre.exe' }
    const args = lib ? ['--with-library', lib.root] : []
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref()
    return { ok: true, message: '正在启动 calibre' }
  })

  /** 让用户选一个目录（转换输出目录等） */
  ipcMain.handle(CH.pickDirectory, async () => {
    const pick = await dialog.showOpenDialog({
      title: '选择文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (pick.canceled || !pick.filePaths.length) return { ok: false, message: '已取消' }
    return { ok: true, message: pick.filePaths[0], path: pick.filePaths[0] }
  })

  /** 在文件管理器里定位路径；文件就选中它，目录就打开它 */
  ipcMain.handle(CH.revealPath, (_e, target: string) => {
    if (!target) return { ok: false, message: '没有路径' }
    if (!existsSync(target)) return { ok: false, message: '路径不存在，可能已被移动或删除' }
    shell.showItemInFolder(target)
    return { ok: true, message: '' }
  })
}

export { calibredb }
