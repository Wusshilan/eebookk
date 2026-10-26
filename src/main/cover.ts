import { execFile } from 'node:child_process'
import { dialog } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { calibreExe, isCalibreRunning } from './env'
import { ctx } from './ctx'

const run = promisify(execFile)

/** 用户选一张本地图片，返回 data URL 给渲染层做预览 / 裁剪 */
export async function pickCoverImage(): Promise<{ ok: boolean; dataUrl?: string; name?: string; message?: string }> {
  const res = await dialog.showOpenDialog({
    title: '选择封面图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]
  })
  if (res.canceled || !res.filePaths.length) return { ok: false, message: '已取消' }
  const file = res.filePaths[0]
  try {
    const buf = readFileSync(file)
    const ext = file.split('.').pop()?.toLowerCase() ?? 'jpeg'
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      name: file.split(/[\\/]/).pop()
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '读取图片失败' }
  }
}

/**
 * 读封面为 data URL。
 * 为什么不直接在渲染层 fetch('bookcover://...')：Chromium 只允许
 * chrome/http/https/data 这些协议跨源 fetch，自定义协议会被 CORS 直接拒掉，
 * 而 canvas 又需要未被污染的像素来做裁剪，所以走 IPC 最稳。
 */
export function readCoverDataUrl(bookId: number): { ok: boolean; dataUrl?: string; message?: string } {
  const file = ctx.library?.coverPath(bookId)
  if (!file) return { ok: false, message: '这本书没有封面' }
  try {
    const buf = readFileSync(file)
    const mime = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '读取封面失败' }
  }
}

/**
 * 写封面。走 calibredb 的 cover 字段，calibre 会自己把图压成 cover.jpg
 * 并更新 has_cover，比我们自己往书目录里塞文件安全。
 */
export async function applyCover(
  bookId: number,
  dataUrl: string
): Promise<{ ok: boolean; message: string }> {
  if (await isCalibreRunning()) {
    ctx.calibreRunning = true
    return { ok: false, message: 'calibre 正在运行，写入被锁定。请先关闭 calibre。' }
  }
  const lib = ctx.ensureLibrary()
  if (!lib) return { ok: false, message: '书库未就绪' }

  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl)
  if (!m) return { ok: false, message: '封面数据格式不正确' }

  const dir = join(app.getPath('userData'), 'tmp')
  mkdirSync(dir, { recursive: true })
  const ext = m[1].toLowerCase() === 'png' ? 'png' : m[1].toLowerCase() === 'webp' ? 'webp' : 'jpg'
  const file = join(dir, `cover-${bookId}-${Date.now()}.${ext}`)
  writeFileSync(file, Buffer.from(m[2], 'base64'))

  try {
    await run(
      calibreExe('calibredb'),
      ['set_metadata', String(bookId), '--field', `cover:${file}`, '--with-library', lib.root],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    ctx.reload()
    return { ok: true, message: '封面已更新' }
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    return { ok: false, message: err.stderr?.trim() || err.message || '写入封面失败' }
  }
}

/** 移除封面（calibre 会退回自动生成的默认封面） */
export async function removeCover(bookId: number): Promise<{ ok: boolean; message: string }> {
  if (await isCalibreRunning()) {
    ctx.calibreRunning = true
    return { ok: false, message: 'calibre 正在运行，写入被锁定。请先关闭 calibre。' }
  }
  const lib = ctx.ensureLibrary()
  if (!lib) return { ok: false, message: '书库未就绪' }
  try {
    await run(
      calibreExe('calibredb'),
      ['set_metadata', String(bookId), '--field', 'cover:', '--with-library', lib.root],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    ctx.reload()
    return { ok: true, message: '封面已移除' }
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    return { ok: false, message: err.stderr?.trim() || err.message || '移除封面失败' }
  }
}
