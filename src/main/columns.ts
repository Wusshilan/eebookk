import { DatabaseSync } from 'node:sqlite'
import type { CustomColumn } from '../shared/types'

/**
 * calibre 自定义列（custom columns）的读取与写库取值转换。
 *
 * 存储形态随 calibre 版本有两条路：
 * - normalized = 1：custom_column_<id>(id, value, link) 存值，
 *   books_custom_column_<id>_link(book, value[, extra]) 存书和值的关联；
 * - normalized = 0：custom_column_<id>(id, book, value) 直接一行一本书。
 * 这里不信任 normalized 标记，直接看表里有没有 book 列，老库也能读。
 */

export interface ColumnInfo extends CustomColumn {
  normalized: boolean
  editable: boolean
}

interface RawColumnRow {
  id: number
  label: string
  name: string
  datatype: string
  is_multiple: number
  normalized: number
  display: string
  editable: number
}

interface ValueRow {
  book: number
  value: unknown
}

interface TableColumn {
  name: string
}

function parseOptions(display: string): string[] {
  try {
    const parsed = JSON.parse(display || '{}') as { enum_values?: unknown }
    const list = parsed.enum_values
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** 从已经打开的 metadata.db 里读列定义；出错返回 []，不能因为一个坏列毁掉整库读取 */
export function readColumnDefs(db: DatabaseSync): ColumnInfo[] {
  try {
    const rows = db
      .prepare(
        `select id, label, name, datatype, is_multiple, normalized, display, editable
         from custom_columns where mark_for_delete = 0 order by name`
      )
      .all() as unknown as RawColumnRow[]
    return rows.map((r) => ({
      id: Number(r.id),
      label: `#${String(r.label ?? '').replace(/^#/, '')}`,
      name: r.name ?? '',
      datatype: String(r.datatype ?? '').toLowerCase(),
      isMultiple: Boolean(r.is_multiple),
      options: parseOptions(r.display),
      normalized: Boolean(r.normalized),
      editable: Boolean(r.editable)
    }))
  } catch {
    // 很老的书库没有 custom_columns 表
    return []
  }
}

/** 单独开连接读列定义，供写库前查 datatype */
export function readColumns(dbFile: string): ColumnInfo[] {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    return readColumnDefs(db)
  } catch {
    return []
  } finally {
    db?.close()
  }
}

/** 只保留契约里 CustomColumn 的字段，避免把内部字段发给渲染层 */
export function publicColumns(cols: ColumnInfo[]): CustomColumn[] {
  return cols.map((c) => ({
    id: c.id,
    label: c.label,
    name: c.name,
    datatype: c.datatype,
    isMultiple: c.isMultiple,
    options: c.options
  }))
}

/** calibre 里 datetime 存的是 UTC 时间串，取日期部分；0101-01-01 视为空 */
function dateOnly(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (!m) return ''
  if (Number(m[1]) < 1000) return ''
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** 把库里的原始值转成界面上好用的字符串（和写库输入保持同一套语义） */
export function formatCustomValue(datatype: string, raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  switch (datatype) {
    case 'bool':
      // calibre 自己也不显示 false（只显示「是」），这里跟着它：0 当成没值
      return Number(raw) ? '1' : ''
    case 'rating': {
      // 库里存 0–10，界面统一按 0–5 星；0 在 calibre 里等于没有评分
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) return ''
      return String(n / 2)
    }
    case 'datetime':
    case 'date':
      return dateOnly(String(raw))
    case 'int': {
      const n = Number(raw)
      // calibre 自己的界面把 int 列的 0 当空
      return Number.isFinite(n) && n !== 0 ? String(n) : ''
    }
    case 'float':
      return String(raw)
    default:
      return String(raw)
  }
}

/**
 * 读出所有自定义列的值，返回 bookId -> { '#label': value }。
 * 多值列按 calibre 的显示习惯用「, 」连接。
 */
export function readCustomValues(
  db: DatabaseSync,
  cols: ColumnInfo[]
): Map<number, Record<string, string>> {
  const out = new Map<number, Record<string, string>>()

  const add = (book: number, col: ColumnInfo, value: string): void => {
    if (!book || !value) return
    const rec = out.get(book) ?? {}
    if (col.isMultiple) {
      rec[col.label] = rec[col.label] ? `${rec[col.label]}, ${value}` : value
    } else {
      rec[col.label] = value
    }
    out.set(book, rec)
  }

  for (const col of cols) {
    if (col.datatype === 'composite') continue // 复合列是模板算出来的，库里没有值
    const table = `custom_column_${col.id}`
    try {
      const info = db
        .prepare(`pragma table_info("${table}")`)
        .all() as unknown as TableColumn[]
      if (!info.length) continue
      const hasBook = info.some((c) => c.name === 'book')
      if (hasBook) {
        const rows = db
          .prepare(`select book as book, value as value from "${table}" order by id`)
          .all() as unknown as ValueRow[]
        for (const r of rows) add(Number(r.book), col, formatCustomValue(col.datatype, r.value))
      } else {
        const linkTable = `books_custom_column_${col.id}_link`
        const rows = db
          .prepare(
            `select l.book as book, c.value as value
             from "${linkTable}" l join "${table}" c on c.id = l.value
             order by l.id`
          )
          .all() as unknown as ValueRow[]
        for (const r of rows) add(Number(r.book), col, formatCustomValue(col.datatype, r.value))
      }
    } catch {
      // 单列结构异常就跳过，别让整库读不出来
    }
  }
  return out
}

/** 清空某一列时 calibre CLI 接受的写法（实测：text/enum/series/date 用空串，bool 用 false，rating/int 用 0） */
function clearToken(datatype: string): string {
  switch (datatype) {
    case 'bool':
      return 'false'
    case 'rating':
    case 'int':
    case 'float':
      return '0'
    default:
      return ''
  }
}

/**
 * 把界面传的值转成 calibredb --field 接受的形式。
 * 返回 error 时不要写库：枚举值写错 calibre 会静默忽略（exit=0），必须提前拦。
 */
export function toFieldValue(
  col: ColumnInfo,
  raw: string | null | undefined
): { value: string; error?: string } {
  const datatype = col.datatype
  if (raw == null || !raw.trim()) return { value: clearToken(datatype) }
  const v = raw.trim()

  switch (datatype) {
    case 'bool': {
      const s = v.toLowerCase()
      if (['1', 'true', 'yes', 'y', '是'].includes(s)) return { value: 'true' }
      if (['0', 'false', 'no', 'n', '否'].includes(s)) return { value: 'false' }
      return { value: '', error: '是/否列只认 true / false 或 1 / 0' }
    }
    case 'rating': {
      if (!/^\d+$/.test(v)) return { value: '', error: '评分列填 0–5 的整数星数' }
      const n = Number(v)
      if (n < 0 || n > 5) return { value: '', error: '评分列填 0–5 的整数星数' }
      return { value: String(n) }
    }
    case 'datetime':
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        // 和 pubdate 同一个坑：不带时区时 calibre 会按本地时区解释，日期可能差一天
        return { value: `${v}T00:00:00Z` }
      }
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return { value: v }
      return { value: '', error: '日期按 yyyy-mm-dd 填，比如 2008-05-01' }
    }
    case 'int':
      if (!/^-?\d+$/.test(v)) return { value: '', error: '这一列要填整数' }
      return { value: v }
    case 'float':
      if (!Number.isFinite(Number(v))) return { value: '', error: '这一列要填数字' }
      return { value: v }
    case 'enumeration':
      if (col.options.length && !col.options.includes(v)) {
        return {
          value: '',
          error: `「${v}」不是这个列的选项${col.options.length ? `（可选：${col.options.join('、')}）` : ''}`
        }
      }
      return { value: v }
    default:
      return { value: v }
  }
}
