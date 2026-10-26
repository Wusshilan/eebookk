/**
 * 标签 / 作者 / 系列 / 出版社的聚合与批量改写。
 *
 * 写入统一走 calibredb：calibre 的 metadata.db 上挂着 Python 侧触发器，
 * 直写会报 no such function: title_sort。而 calibredb 的库锁是全局的 ——
 * calibre 主程序一开着，连 list 都会失败，所以写操作前必须先用
 * isCalibreRunning() 拦一道，并把原因明确返回给渲染层。
 *
 * 写回策略与 workbench.ts 的 tagsCleanup 保持一致：
 *   1. 在内存里算出每本书改完后的最终标签 / 作者串
 *   2. 只对真的有变化的书逐本调 calibredb set_metadata
 *   3. 单本失败不影响其他书，最后把失败清单一起还给渲染层
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import { CH } from '../shared/ipc'
import type { EditResult, TaxonomyRow, TaxonomySummary } from '../shared/types'
import { ctx } from './ctx'
import { calibreExe, isCalibreRunning } from './env'

const run = promisify(execFile)

/** 多作者写回 calibre 时的分隔符，与 workbench.ts 保持一致 */
const AUTHOR_SEP = ' & '

/** 单次写回的结果；shared 里的 EditResult 没有 message，这里补一个 */
export interface TaxonomyEditResult {
  ok: boolean
  updated: number
  failed: EditResult['failed']
  message?: string
}

function failResult(message: string): TaxonomyEditResult {
  return { ok: false, updated: 0, failed: [], message }
}

/* ---------------- 聚合 ---------------- */

/** calibre 把多作者存成 'A & B'，渲染层也是按这个格式拆的 */
function splitAuthors(authors: string): string[] {
  if (!authors) return []
  return authors
    .split('&')
    .map((s) => s.trim())
    .filter(Boolean)
}

function bump(map: Map<string, TaxonomyRow>, name: string, bookId: number): void {
  const hit = map.get(name)
  if (hit) {
    hit.count += 1
    hit.bookIds.push(bookId)
    return
  }
  map.set(name, { name, count: 1, bookIds: [bookId] })
}

function toRows(map: Map<string, TaxonomyRow>): TaxonomyRow[] {
  // 本数降序，同本数按名称
  return [...map.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')
  )
}

/** 从当前书库聚合四类分类项；没打开书库时返回空集合而不是抛错 */
export function summarize(): TaxonomySummary {
  const lib = ctx.ensureLibrary()
  if (!lib) return { tags: [], authors: [], series: [], publishers: [] }

  const tags = new Map<string, TaxonomyRow>()
  const authors = new Map<string, TaxonomyRow>()
  const series = new Map<string, TaxonomyRow>()
  const publishers = new Map<string, TaxonomyRow>()

  for (const book of lib.all()) {
    // 同一本书里的重复 / 空格变体只算一次，否则 count 会虚高
    const tagNames = new Set<string>()
    for (const tag of book.tags) {
      const name = tag.trim()
      if (name) tagNames.add(name)
    }
    for (const name of tagNames) bump(tags, name, book.id)
    for (const author of new Set(splitAuthors(book.authors))) bump(authors, author, book.id)
    if (book.series) bump(series, book.series, book.id)
    if (book.publisher) bump(publishers, book.publisher, book.id)
  }

  return {
    tags: toRows(tags),
    authors: toRows(authors),
    series: toRows(series),
    publishers: toRows(publishers)
  }
}

/* ---------------- 写回 ---------------- */

/**
 * 写入前置检查。calibre 运行时 calibredb 会把所有命令（包括只读）都拒掉，
 * 这里先探测一次并同步 ctx.calibreRunning，渲染层据此锁定按钮。
 */
async function guardWritable(): Promise<string | null> {
  ctx.calibreRunning = await isCalibreRunning()
  if (ctx.calibreRunning) {
    return 'calibre 正在运行，calibredb 会拒绝一切写入（包括只读命令）。请先完全退出 calibre，再回来改写标签 / 作者。'
  }
  if (!ctx.ensureLibrary()) return '书库未就绪，请先在设置里指定 calibre 的书库路径'
  return null
}

interface TouchedBook {
  id: number
  title: string
  value: string
}

/** 逐本写回一个字段；失败逐本记录，不因为一本失败就中断整批 */
async function applyField(
  touched: TouchedBook[],
  field: 'tags' | 'authors'
): Promise<TaxonomyEditResult> {
  const failed: EditResult['failed'] = []
  if (!touched.length) return { ok: true, updated: 0, failed }
  const lib = ctx.ensureLibrary()
  if (!lib) return failResult('书库未就绪')

  let updated = 0
  for (const item of touched) {
    try {
      await run(
        calibreExe('calibredb'),
        [
          'set_metadata', String(item.id),
          '--field', `${field}:${item.value}`,
          '--with-library', lib.root
        ],
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      )
      updated += 1
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      failed.push({ id: item.id, title: item.title, error: err.stderr ?? err.message ?? '写入失败' })
    }
    // 逐本 spawn 比较慢，把进度推回去，别让用户对着一个禁用的按钮干等
    ctx.emit(CH.evtTaxonomy, {
      done: updated + failed.length,
      total: touched.length,
      field
    })
  }
  ctx.emit(CH.evtTaxonomy, { done: touched.length, total: touched.length, field, finished: true })
  if (updated) ctx.reload()
  return { ok: failed.length === 0, updated, failed }
}

/**
 * 标签改写核心：把 from 里的标签从全库替换成 target。
 * target 为空串表示删除这几个标签（水印清理、批量删除都走这里）。
 * 同一本书里若替换后出现重名，自动去重。
 */
async function rewriteTags(names: string[], target: string): Promise<TaxonomyEditResult> {
  const blocked = await guardWritable()
  if (blocked) return failResult(blocked)
  const lib = ctx.ensureLibrary()
  if (!lib) return failResult('书库未就绪')

  const from = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  const to = target.trim()
  if (!from.length) return failResult('没有选中标签')
  // calibre 的标签字段用英文逗号分隔，标签名里带逗号会写坏整本
  if (from.some((name) => name.includes(',')) || to.includes(',')) {
    return failResult('标签名里不能有英文逗号（calibre 用逗号分隔标签）')
  }

  // 改名成自己 / 合并到自身不算改动
  const rename = new Map<string, string>()
  for (const name of from) if (name !== to) rename.set(name, to)
  if (!rename.size) return { ok: true, updated: 0, failed: [] }

  /** 库里存量的标签可能带首尾空格，原样和 trim 后都查一次 */
  const mappedOf = (raw: string): string | undefined => {
    const direct = rename.get(raw)
    if (direct !== undefined) return direct
    return rename.get(raw.trim())
  }

  const touched: TouchedBook[] = []
  for (const book of lib.all()) {
    let changed = false
    const next: string[] = []
    for (const raw of book.tags) {
      const mapped = mappedOf(raw)
      if (mapped !== undefined) {
        changed = true
        if (mapped && !next.includes(mapped)) next.push(mapped)
        continue
      }
      if (!next.includes(raw)) next.push(raw)
    }
    if (changed) touched.push({ id: book.id, title: book.title, value: next.join(',') })
  }

  if (!touched.length) return { ok: true, updated: 0, failed: [] }
  return applyField(touched, 'tags')
}

/** 作者改名：把该作者名下的书逐本改成新名字，保留其他作者和原顺序 */
async function rewriteAuthor(oldName: string, newName: string): Promise<TaxonomyEditResult> {
  const blocked = await guardWritable()
  if (blocked) return failResult(blocked)
  const lib = ctx.ensureLibrary()
  if (!lib) return failResult('书库未就绪')

  const from = oldName.trim()
  const to = newName.trim()
  if (!from) return failResult('缺少要改名的作者')
  if (!to) return failResult('作者名不能为空')
  // calibre 用 ' & ' 分隔多作者，名字里带 & 会把一个人拆成两个
  if (from.includes('&') || to.includes('&')) {
    return failResult('作者名里不能有 &（calibre 用 & 分隔多作者）')
  }
  if (from === to) return { ok: true, updated: 0, failed: [] }

  const touched: TouchedBook[] = []
  for (const book of lib.all()) {
    const list = splitAuthors(book.authors)
    if (!list.includes(from)) continue
    const next: string[] = []
    for (const name of list) {
      const mapped = name === from ? to : name
      // 新名字恰好也是这本书的作者时不重复
      if (!next.includes(mapped)) next.push(mapped)
    }
    touched.push({ id: book.id, title: book.title, value: next.join(AUTHOR_SEP) })
  }

  if (!touched.length) return { ok: true, updated: 0, failed: [] }
  return applyField(touched, 'authors')
}

/* ---------------- 注册 ---------------- */

export function registerTaxonomy(): void {
  ipcMain.handle(CH.taxonomySummary, () => summarize())

  ipcMain.handle(CH.tagRename, (_e, name: string, next: string) =>
    rewriteTags([String(name ?? '')], String(next ?? ''))
  )

  ipcMain.handle(CH.tagMerge, (_e, names: string[] | string, target: string) => {
    const list = Array.isArray(names) ? names.map((n) => String(n)) : [String(names ?? '')]
    return rewriteTags(list, String(target ?? ''))
  })

  ipcMain.handle(CH.tagDelete, (_e, names: string[] | string) => {
    const list = Array.isArray(names) ? names.map((n) => String(n)) : [String(names ?? '')]
    return rewriteTags(list, '')
  })

  ipcMain.handle(CH.authorRename, (_e, name: string, next: string) =>
    rewriteAuthor(String(name ?? ''), String(next ?? ''))
  )
}
