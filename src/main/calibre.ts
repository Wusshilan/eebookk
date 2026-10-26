import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Book, LibraryStats, LibraryPayload } from '../shared/types'
import { readColumnDefs, readCustomValues } from './columns'

export type { Book, LibraryStats, LibraryPayload }

const SEP = String.fromCharCode(31)

/** 从 calibre 的 gui.json 里读出最近用过的书库（library_usage_stats 取次数最多的） */
function libraryFromCalibreConfig(): string | null {
  const file = join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'calibre',
    'gui.json'
  )
  if (!existsSync(file)) return null
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      library_usage_stats?: Record<string, number>
    }
    const stats = json.library_usage_stats
    if (!stats) return null
    const best = Object.entries(stats).sort((a, b) => b[1] - a[1])[0]
    if (best && existsSync(join(best[0], 'metadata.db'))) return best[0].replace(/\//g, '\\')
  } catch {
    /* gui.json 偶尔不是严格 JSON，忽略 */
  }
  return null
}

export function detectLibraryPath(): string | null {
  const env = process.env.EEBOOKK_LIBRARY
  if (env && existsSync(join(env, 'metadata.db'))) return env
  const fromConfig = libraryFromCalibreConfig()
  if (fromConfig) return fromConfig
  const guess = join(homedir(), 'Calibre 书库')
  if (existsSync(join(guess, 'metadata.db'))) return guess
  return null
}

export function detectCalibreVersion(): string | null {
  for (const base of [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Calibre2') : '',
    'C:\\Program Files\\Calibre2'
  ]) {
    if (base && existsSync(base)) return 'installed'
  }
  return null
}

const BOOK_SQL = `
select
  b.id, b.title, b.path, b.has_cover, b.timestamp, b.pubdate, b.series_index, b.author_sort,
  (select group_concat(a.name, ' & ') from authors a
     join books_authors_link l on l.author = a.id where l.book = b.id) as authors,
  (select group_concat(t.name, char(31)) from tags t
     join books_tags_link l on l.tag = t.id where l.book = b.id) as tags,
  (select group_concat(s.name, char(31)) from series s
     join books_series_link l on l.series = s.id where l.book = b.id) as series,
  (select group_concat(d.format, ',') from data d where d.book = b.id) as formats,
  (select r.rating from ratings r
     join books_ratings_link l on l.rating = r.id where l.book = b.id) as rating,
  (select p.name from publishers p
     join books_publishers_link l on l.publisher = p.id where l.book = b.id) as publisher,
  (select group_concat(g.lang_code, ',') from languages g
     join books_languages_link l on l.lang_code = g.id where l.book = b.id) as languages,
  (select c.text from comments c where c.book = b.id) as comments,
  (select coalesce(sum(d.uncompressed_size), 0) from data d where d.book = b.id) as size_bytes,
  (select max(p.pos_frac) from last_read_positions p where p.book = b.id) as pos_frac,
  (select max(p.epoch) from last_read_positions p where p.book = b.id) as read_epoch
from books b
order by b.timestamp desc
`

interface RawBook {
  id: number
  title: string
  path: string
  has_cover: number
  timestamp: string
  pubdate: string
  series_index: number | null
  author_sort: string | null
  authors: string | null
  tags: string | null
  tags_alt?: string | null
  series: string | null
  formats: string | null
  rating: number | null
  publisher: string | null
  languages: string | null
  comments: string | null
  size_bytes: number | null
  pos_frac: number | null
  read_epoch: number | null
}

export class Library {
  readonly root: string
  readonly dbFile: string
  private books: Book[] = []
  private byId = new Map<number, Book>()

  constructor(root: string) {
    this.root = root
    this.dbFile = join(root, 'metadata.db')
  }

  get isReady(): boolean {
    return existsSync(this.dbFile)
  }

  read(): Book[] {
    const db = new DatabaseSync(this.dbFile, { readOnly: true })
    try {
      const rows = db.prepare(BOOK_SQL).all() as unknown as RawBook[]
      const idents = new Map<number, Record<string, string>>()
      for (const r of db
        .prepare('select book, type, val from identifiers')
        .all() as unknown as { book: number; type: string; val: string }[]) {
        const cur = idents.get(r.book) ?? {}
        cur[r.type] = r.val
        idents.set(r.book, cur)
      }
      // 库里 0 个自定义列时这里直接返回空 Map，不会多查任何表
      const custom = readCustomValues(db, readColumnDefs(db))

      this.books = rows.map((r) => ({
        id: r.id,
        title: r.title,
        authors: r.authors ?? '',
        series: r.series ? r.series.split(SEP)[0] : null,
        seriesIndex: r.series_index,
        tags: r.tags ? r.tags.split(SEP).filter(Boolean) : [],
        formats: r.formats ? r.formats.split(',').filter(Boolean) : [],
        hasCover: r.has_cover === 1,
        timestamp: r.timestamp,
        pubdate: r.pubdate,
        rating: r.rating,
        descLen: r.comments ? r.comments.length : 0,
        posFrac: r.pos_frac,
        readEpoch: r.read_epoch,
        relPath: r.path,
        sizeBytes: Number(r.size_bytes ?? 0),
        publisher: r.publisher,
        // calibre 9.15 的 books 表没有 subtitle 列，calibredb 也不认这个字段
        subtitle: '',
        // books.sort 是书名排序，作者排序在 books.author_sort
        authorSort: r.author_sort ?? '',
        languages: r.languages,
        identifiers: idents.get(r.id) ?? {},
        comments: r.comments ?? '',
        custom: custom.get(r.id) ?? {}
      }))
      this.byId = new Map(this.books.map((b) => [b.id, b]))
      return this.books
    } finally {
      db.close()
    }
  }

  all(): Book[] {
    return this.books
  }

  book(id: number): Book | undefined {
    return this.byId.get(id)
  }

  stats(): LibraryStats {
    const b = this.books
    return {
      total: b.length,
      withDesc: b.filter((x) => x.descLen > 0).length,
      withTags: b.filter((x) => x.tags.length > 0).length,
      withSeries: b.filter((x) => x.series).length,
      withRating: b.filter((x) => x.rating != null).length,
      withCover: b.filter((x) => x.hasCover).length,
      withIdentifier: b.filter((x) => Object.keys(x.identifiers).length > 0).length,
      epub: b.filter((x) => x.formats.includes('EPUB')).length,
      started: b.filter((x) => x.posFrac != null).length,
      tags: new Set(b.flatMap((x) => x.tags)).size,
      authors: new Set(b.map((x) => x.authors).filter(Boolean)).size,
      series: new Set(b.map((x) => x.series).filter(Boolean)).size,
      publishers: new Set(b.map((x) => x.publisher).filter(Boolean)).size
    }
  }

  coverPath(id: number): string | null {
    const book = this.byId.get(id)
    if (!book || !book.hasCover) return null
    const p = join(this.root, book.relPath, 'cover.jpg')
    return existsSync(p) ? p : null
  }

  /** 找到某本书在磁盘上的实际格式文件 */
  filePath(id: number, format?: string): string | null {
    const book = this.byId.get(id)
    if (!book) return null
    const dir = join(this.root, book.relPath)
    if (!existsSync(dir)) return null
    const want = format?.toUpperCase()
    const exts = want ? [want.toLowerCase()] : book.formats.map((f) => f.toLowerCase())
    let files: string[] = []
    try {
      files = readdirSync(dir)
    } catch {
      return null
    }
    for (const ext of exts) {
      const hit = files.find((f) => f.toLowerCase().endsWith(`.${ext}`))
      if (hit) return join(dir, hit)
    }
    return null
  }

  sizeOf(id: number): number {
    const p = this.filePath(id)
    if (!p) return 0
    try {
      return statSync(p).size
    } catch {
      return 0
    }
  }

  payload(calibreRunning: boolean): LibraryPayload {
    return {
      path: this.root,
      calibreVersion: detectCalibreVersion(),
      calibreRunning,
      stats: this.stats(),
      books: this.books
    }
  }
}
