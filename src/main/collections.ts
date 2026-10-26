import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CH } from '../shared/ipc'
import type { BookList, CollectionsStore } from '../shared/types'
import { ctx } from './ctx'

/**
 * 收藏 / 书单后端。
 *
 * 这两样东西 calibre 本身没有，本应用也**不写 calibre**：
 * 塞进 tag 会把用户的标签体系搞乱，走 calibredb 还会被 calibre 的全局库锁拦住。
 * 所以全部落在 userData/collections.json，结构就是 shared/types.ts 的 CollectionsStore。
 *
 * 约定：
 *  - 任何变更都是「改内存 → 原子落盘 → ctx.emit(CH.evtCollections, store)」
 *  - IPC 一律返回最新的 store，渲染层直接 setState，侧栏因此能立刻刷新
 *  - 文件坏了不崩：隔离成 .bad-<时间戳> 后从空 store 开始，绝不让用户卡在启动页
 */

const FILE_NAME = 'collections.json'
/** 书单名长度上限：侧栏一行放不下太长的名字 */
const NAME_MAX = 60

/** 内存里的当前 store，null 表示还没从磁盘读过 */
let store: CollectionsStore | null = null

function emptyStore(): CollectionsStore {
  return { favorites: [], lists: [] }
}

function dataFile(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/* ---------------- 容错清洗 ---------------- */

function toBookId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 去重并保持顺序 —— 收藏和书单都靠「数组顺序即用户添加顺序」 */
function cleanBookIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  const out: number[] = []
  for (const raw of value) {
    const id = toBookId(raw)
    if (id == null || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 名字统一收掉多余空白；空名用 fallback，绝不落一个无名书单 */
function cleanName(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return (text || fallback).slice(0, NAME_MAX)
}

function newListId(existing: BookList[]): string {
  const taken = new Set(existing.map((item) => item.id))
  let id = ''
  do {
    id = `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  } while (taken.has(id))
  return id
}

function sanitizeList(raw: unknown, index: number): BookList | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<BookList>
  const now = Date.now()
  const createdAt = Number.isFinite(item.createdAt) ? Number(item.createdAt) : now
  return {
    id:
      typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : `list-recovered-${index + 1}`,
    name: cleanName(item.name, `书单 ${index + 1}`),
    bookIds: cleanBookIds(item.bookIds),
    createdAt,
    updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : createdAt
  }
}

function sanitizeStore(raw: unknown): CollectionsStore {
  if (!raw || typeof raw !== 'object') return emptyStore()
  const data = raw as Partial<CollectionsStore>
  const lists: BookList[] = []
  const seen = new Set<string>()
  if (Array.isArray(data.lists)) {
    data.lists.forEach((item, index) => {
      const list = sanitizeList(item, index)
      if (!list) return
      // id 撞车时重新发一个，否则侧栏 key 和「当前书单」判断都会错乱
      if (seen.has(list.id)) list.id = newListId(lists)
      seen.add(list.id)
      lists.push(list)
    })
  }
  return { favorites: cleanBookIds(data.favorites), lists }
}

/* ---------------- 读写 ---------------- */

function readStore(): CollectionsStore {
  const file = dataFile()
  if (!existsSync(file)) return emptyStore()
  try {
    return sanitizeStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch (e) {
    console.warn('[collections] collections.json 读取失败，已隔离并从空 store 开始', e)
    try {
      // 隔离而不是直接覆盖：万一里面还有用户没备份过的书单，可以手工捞回来
      renameSync(file, `${file}.bad-${Date.now().toString(36)}`)
    } catch {
      /* 隔离失败也无所谓，下一次写盘会覆盖 */
    }
    return emptyStore()
  }
}

function current(): CollectionsStore {
  if (!store) store = readStore()
  return store
}

function persist(): void {
  const file = dataFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 先写临时文件再改名：写到一半断电也不会留下半截 JSON
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(current(), null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    // 写盘失败不能让收藏功能整个挂掉：内存里的状态仍然可用，界面照常响应
    console.error('[collections] collections.json 写入失败', e)
  }
}

function commit(): CollectionsStore {
  const data = current()
  persist()
  ctx.emit(CH.evtCollections, data)
  return data
}

/* ---------------- 收藏 ---------------- */

function favoriteToggle(rawId: unknown): CollectionsStore {
  const data = current()
  const id = toBookId(rawId)
  if (id == null) return data
  const at = data.favorites.indexOf(id)
  if (at >= 0) data.favorites.splice(at, 1)
  else data.favorites.push(id)
  return commit()
}

/* ---------------- 书单 ---------------- */

function listCreate(rawName: unknown): CollectionsStore {
  const data = current()
  const now = Date.now()
  data.lists.push({
    id: newListId(data.lists),
    name: cleanName(rawName, `书单 ${data.lists.length + 1}`),
    bookIds: [],
    createdAt: now,
    updatedAt: now
  })
  return commit()
}

function listRename(id: unknown, rawName: unknown): CollectionsStore {
  const data = current()
  const list = data.lists.find((item) => item.id === id)
  if (!list) return data
  const name = cleanName(rawName, list.name)
  if (name === list.name) return data
  list.name = name
  list.updatedAt = Date.now()
  return commit()
}

function listDelete(id: unknown): CollectionsStore {
  const data = current()
  const at = data.lists.findIndex((item) => item.id === id)
  if (at < 0) return data
  data.lists.splice(at, 1)
  return commit()
}

/** 按传入顺序去重追加，已在书单里的保持原位不动 */
function listAddBooks(id: unknown, rawIds: unknown): CollectionsStore {
  const data = current()
  const list = data.lists.find((item) => item.id === id)
  if (!list) return data
  const ids = cleanBookIds(rawIds)
  if (!ids.length) return data
  const has = new Set(list.bookIds)
  let changed = false
  for (const bookId of ids) {
    if (has.has(bookId)) continue
    has.add(bookId)
    list.bookIds.push(bookId)
    changed = true
  }
  if (!changed) return data
  list.updatedAt = Date.now()
  return commit()
}

/** 移除时保住剩余顺序，用户眼里的「第几本」不会跳 */
function listRemoveBooks(id: unknown, rawIds: unknown): CollectionsStore {
  const data = current()
  const list = data.lists.find((item) => item.id === id)
  if (!list) return data
  const drop = new Set(cleanBookIds(rawIds))
  if (!drop.size) return data
  const next = list.bookIds.filter((bookId) => !drop.has(bookId))
  if (next.length === list.bookIds.length) return data
  list.bookIds = next
  list.updatedAt = Date.now()
  return commit()
}

/* ---------------- 注册 ---------------- */

export function registerCollections(): void {
  ipcMain.handle(CH.collectionsGet, () => current())
  ipcMain.handle(CH.favoriteToggle, (_e, bookId: unknown) => favoriteToggle(bookId))
  ipcMain.handle(CH.listCreate, (_e, name: unknown) => listCreate(name))
  ipcMain.handle(CH.listRename, (_e, id: unknown, name: unknown) => listRename(id, name))
  ipcMain.handle(CH.listDelete, (_e, id: unknown) => listDelete(id))
  ipcMain.handle(CH.listAddBooks, (_e, id: unknown, bookIds: unknown) => listAddBooks(id, bookIds))
  ipcMain.handle(CH.listRemoveBooks, (_e, id: unknown, bookIds: unknown) =>
    listRemoveBooks(id, bookIds)
  )
}
