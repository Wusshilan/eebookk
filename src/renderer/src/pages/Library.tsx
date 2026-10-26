import { useMemo, useState } from 'react'
import type { Book } from '../../../shared/types'
import { useApp } from '../app/context'
import { coverUrl, formatBytes, formatDate } from '../lib/cover'
import { IconCheck, IconConvert, IconDevice, IconHash, IconPlus, IconRows, IconSearch, IconSliders, IconTiles, IconUser } from '../icons'
import { CH } from '../../../shared/ipc'

type SortKey = 'timestamp' | 'title' | 'authors' | 'size' | 'series' | 'rating'
type FilterKey = 'all' | 'no-desc' | 'no-tags' | 'no-cover' | 'reading' | 'no-epub'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'timestamp', label: '入库时间' },
  { key: 'title', label: '书名' },
  { key: 'authors', label: '作者' },
  { key: 'series', label: '系列' },
  { key: 'size', label: '文件大小' },
  { key: 'rating', label: '评分' }
]

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'no-desc', label: '缺简介' },
  { key: 'no-tags', label: '缺标签' },
  { key: 'no-cover', label: '缺封面' },
  { key: 'no-epub', label: '无 EPUB' }
]

function matchFilter(b: Book, f: FilterKey): boolean {
  switch (f) {
    case 'no-desc':
      return b.descLen === 0
    case 'no-tags':
      return b.tags.length === 0
    case 'no-cover':
      return !b.hasCover
    case 'no-epub':
      return !b.formats.includes('EPUB')
    case 'reading':
      return b.posFrac != null
    default:
      return true
  }
}

function sortBooks(books: Book[], key: SortKey, desc: boolean): Book[] {
  const dir = desc ? -1 : 1
  return [...books].sort((a, b) => {
    let r = 0
    switch (key) {
      case 'title':
        r = a.title.localeCompare(b.title, 'zh')
        break
      case 'authors':
        r = a.authors.localeCompare(b.authors, 'zh')
        break
      case 'series':
        r = (a.series ?? '').localeCompare(b.series ?? '', 'zh') || (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0)
        break
      case 'size':
        r = a.sizeBytes - b.sizeBytes
        break
      case 'rating':
        r = (a.rating ?? 0) - (b.rating ?? 0)
        break
      default:
        r = a.timestamp.localeCompare(b.timestamp)
    }
    return r * dir
  })
}

export default function LibraryPage(): React.ReactElement {
  const { books, stats, search, setSearch, navigate, selected, setSelected, toggleSelected, clearSelection, route, calibreRunning, reload, toast } = useApp()
  const [sort, setSort] = useState<SortKey>('timestamp')
  const [desc, setDesc] = useState(true)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [view, setView] = useState<'grid' | 'table'>('grid')

  // 从标签页 / 作者页点进来时带着范围
  const scopeTag = route.name === 'library' ? route.tag : undefined
  const scopeAuthor = route.name === 'library' ? route.author : undefined

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = books.filter((b) => matchFilter(b, filter))
    if (scopeTag) list = list.filter((b) => b.tags.includes(scopeTag))
    if (scopeAuthor) {
      list = list.filter((b) => b.authors.split('&').map((s) => s.trim()).includes(scopeAuthor))
    }
    if (q) {
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.authors.toLowerCase().includes(q) ||
          b.tags.some((t) => t.toLowerCase().includes(q)) ||
          (b.series ?? '').toLowerCase().includes(q) ||
          (b.publisher ?? '').toLowerCase().includes(q)
      )
    }
    return sortBooks(list, sort, desc)
  }, [books, filter, sort, desc, search, scopeTag, scopeAuthor])

  const allSelected = filtered.length > 0 && filtered.every((b) => selected.includes(b.id))

  const toggleAll = (): void => {
    if (allSelected) clearSelection()
    else setSelected(filtered.map((b) => b.id))
  }

  const onSort = (key: SortKey): void => {
    if (key === sort) setDesc(!desc)
    else {
      setSort(key)
      setDesc(key === 'timestamp' || key === 'size' || key === 'rating')
    }
  }

  /** 弹文件选择框，把书加进 calibre 书库 */
  const addBooks = async (): Promise<void> => {
    const res = await window.api.invoke<{ ok: boolean; added: number; message: string }>(CH.libraryAdd)
    if (res.ok) {
      toast(res.message || `已添加 ${res.added} 个文件`, 'success')
      await reload()
    } else if (res.message !== '已取消') {
      toast(res.message, 'error')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">书库</h1>
        <span className="page-sub">
          {filtered.length} / {stats.total} 本
        </span>
        <span className="spacer" />

        <div className="seg">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`seg-item${filter === f.key ? ' is-active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <select
          className="select"
          value={sort}
          onChange={(e) => {
            const k = e.target.value as SortKey
            setSort(k)
            // 和点表头保持一致：默认降序的字段才降序，其余升序
            setDesc(k === 'timestamp' || k === 'size' || k === 'rating')
          }}
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              按{s.label}
            </option>
          ))}
        </select>
        <button className="btn btn-sm btn-ghost" onClick={() => setDesc(!desc)} title="切换升降序">
          {desc ? '降序' : '升序'}
        </button>

        <div className="seg">
          <button className={`seg-item${view === 'grid' ? ' is-active' : ''}`} onClick={() => setView('grid')} title="封面墙">
            <IconTiles width={16} height={16} />
          </button>
          <button className={`seg-item${view === 'table' ? ' is-active' : ''}`} onClick={() => setView('table')} title="表格">
            <IconRows width={16} height={16} />
          </button>
        </div>

        <button
          className="btn btn-sm"
          disabled={calibreRunning}
          title={calibreRunning ? 'calibre 正在运行，添加书籍需要先关闭它' : '把电子书文件加进 calibre 书库'}
          onClick={() => void addBooks()}
        >
          <IconPlus width={15} height={15} />
          添加书籍
        </button>
      </div>

      {scopeTag || scopeAuthor ? (
        <div className="search-banner">
          {scopeTag ? <IconHash width={16} height={16} /> : <IconUser width={16} height={16} />}
          {scopeTag ? `标签「${scopeTag}」` : `作者「${scopeAuthor}」`} · {filtered.length} 本
          <button className="btn btn-sm" onClick={() => navigate({ name: 'library' })}>
            清除范围
          </button>
        </div>
      ) : null}

      {search ? (
        <div className="search-banner">
          <IconSearch width={16} height={16} />
          正在搜索「{search}」，命中 {filtered.length} 本
          <button className="btn btn-sm" onClick={() => setSearch('')}>
            清除
          </button>
        </div>
      ) : null}

      {selected.length > 0 ? (
        <div className="selbar">
          <span className="selbar-count">已选 {selected.length} 本</span>
          <button className="btn btn-sm" onClick={toggleAll}>
            {allSelected ? '取消全选' : '全选当前'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={clearSelection}>
            清空
          </button>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => navigate({ name: 'workbench' })}>
            <IconSliders width={16} height={16} />
            去整理
          </button>
          <button className="btn btn-sm" onClick={() => navigate({ name: 'convert' })}>
            <IconConvert width={16} height={16} />
            去转换
          </button>
          <button className="btn btn-sm" onClick={() => navigate({ name: 'device' })}>
            <IconDevice width={16} height={16} />
            推送 Kindle
          </button>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="empty">没有符合条件的书</div>
      ) : view === 'grid' ? (
        <div className="grid grid-dense">
          {filtered.map((b) => (
            <article
              key={b.id}
              className={`card${selected.includes(b.id) ? ' is-selected' : ''}`}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey) {
                  e.preventDefault()
                  toggleSelected(b.id)
                } else {
                  navigate({ name: 'book', id: b.id })
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                toggleSelected(b.id)
              }}
              title={`${b.title}\n${b.authors || '佚名'}`}
            >
              <img
                src={coverUrl(b.id)}
                alt={b.title}
                loading="lazy"
                width={145}
                height={194}
                draggable={false}
              />
              <div className="card-check" onClick={(e) => {
                e.stopPropagation()
                toggleSelected(b.id)
              }}>
                <IconCheck width={13} height={13} />
              </div>
              <div className="card-meta">
                <div className="card-title">{b.title}</div>
                <div className="card-author">{b.authors || '佚名'}</div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 34 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </th>
              {SORTS.map((s) => (
                <th key={s.key} className="is-sortable" onClick={() => onSort(s.key)}>
                  {s.label}
                  {sort === s.key ? <span className="sort-mark">{desc ? ' ↓' : ' ↑'}</span> : null}
                </th>
              ))}
              <th>格式</th>
              <th>标签</th>
              <th>大小</th>
              <th>入库</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => (
              <tr
                key={b.id}
                className={selected.includes(b.id) ? 'is-selected' : ''}
                onClick={() => navigate({ name: 'book', id: b.id })}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.includes(b.id)} onChange={() => toggleSelected(b.id)} />
                </td>
                <td className="cell-title" title={b.title}>{b.title}</td>
                <td className="cell-muted">{b.authors || '佚名'}</td>
                <td className="cell-muted">{b.series ?? '—'}</td>
                <td className="cell-muted">{b.rating ? '★'.repeat(Math.round(b.rating / 2)) : '—'}</td>
                <td className="cell-muted">{b.formats.join(' / ')}</td>
                <td className="cell-muted">
                  {b.tags.slice(0, 2).join('、') || <span style={{ color: '#c9a227' }}>无标签</span>}
                </td>
                <td className="cell-muted">{formatBytes(b.sizeBytes)}</td>
                <td className="cell-muted">{formatDate(b.timestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ height: 12 }} />

    </div>
  )
}
