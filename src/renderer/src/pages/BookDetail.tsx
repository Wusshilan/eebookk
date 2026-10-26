import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CH } from '../../../shared/ipc'
import type { Book, CollectionsStore } from '../../../shared/types'
import { useApp } from '../app/context'
import { coverUrl, formatBytes, formatDate, htmlToText } from '../lib/cover'
import {
  IconBook, IconBookmark, IconConvert, IconDevice, IconFolder, IconPlay, IconTrash
} from '../icons'
import CoverEditor from '../components/CoverEditor'
import MetadataEditor from '../components/MetadataEditor'
import { CopyText, METADATA_CSS, pubdateInput } from '../components/MetadataFields'

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="kv">
      <div className="kv-k">{label}</div>
      <div className="kv-v">{children}</div>
    </div>
  )
}

export default function BookDetail({ id }: { id: number }): React.ReactElement {
  const {
    books, navigate, calibreRunning, reload, toast,
    collections, toggleFavorite, isFavorite, reloadCollections, confirm, ask
  } = useApp()
  const book = useMemo(() => books.find((b) => b.id === id), [books, id])
  const [listMenuOpen, setListMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listMenuRef = useRef<HTMLDivElement>(null)

  // 下拉打开时：点外部或按 Esc 关闭
  useEffect(() => {
    if (!listMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (listMenuRef.current?.contains(t)) return
      // 触发器自己也算「内部」，否则点一下会关了又开
      if (triggerRef.current?.contains(t)) return
      setListMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setListMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [listMenuOpen])

  const [editing, setEditing] = useState(false)
  const [coverOpen, setCoverOpen] = useState(
    // 截图校验用：#book:747,cover 会直接打开封面编辑器
    () => window.location.hash.endsWith(',cover')
  )
  const [busyAction, setBusyAction] = useState<string | null>(null)

  // 换书时退出编辑态，别把上一本的草稿套到新书上
  useEffect(() => {
    setEditing(false)
    setListMenuOpen(false)
  }, [book?.id])

  if (!book) {
    return (
      <div className="page">
        <div className="empty">找不到这本书</div>
      </div>
    )
  }

  const openBook = async (format?: string): Promise<void> => {
    const res = await window.api.invoke<{ ok: boolean; message: string }>(CH.libraryOpenBook, book.id, format)
    if (!res.ok && res.message) toast(res.message, 'error')
  }

  const reveal = async (): Promise<void> => {
    const res = await window.api.invoke<{ ok: boolean; message: string }>(CH.libraryRevealBook, book.id)
    if (!res.ok) toast(res.message || '打开文件夹失败', 'error')
  }

  /** 单本工具：统一收口，成功失败都走 toast */
  const runTool = async (key: string, channel: string, ...args: unknown[]): Promise<void> => {
    setBusyAction(key)
    try {
      const res = await window.api.invoke<{ ok: boolean; message: string }>(channel, ...args)
      toast(res.message || (res.ok ? '完成' : '失败'), res.ok ? 'success' : 'error')
      if (res.ok) await reload()
    } catch (e) {
      toast(String(e), 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const removeBook = async (): Promise<void> => {
    if (calibreRunning) {
      toast('calibre 正在运行，无法删除。请先关闭 calibre。', 'error')
      return
    }
    const yes = await confirm({
      title: `从书库删除《${book.title}》？`,
      message: '书籍文件会先移到回收目录（userData\\trash），再从 calibre 书库里移除。',
      okText: '删除',
      danger: true
    })
    if (!yes) return
    setBusyAction('remove')
    try {
      const res = await window.api.invoke<{ ok: boolean; message: string }>(CH.libraryRemove, [book.id])
      toast(res.message || (res.ok ? '已删除' : '删除失败'), res.ok ? 'success' : 'error')
      if (res.ok) {
        await reload()
        navigate({ name: 'library' })
      }
    } finally {
      setBusyAction(null)
    }
  }

  const onToggleFav = async (): Promise<void> => {
    await toggleFavorite(book.id)
    toast(isFavorite(book.id) ? '已取消收藏' : '已加入收藏', 'success')
  }

  const addToList = async (listId: string): Promise<void> => {
    setListMenuOpen(false)
    const next = await window.api.invoke<CollectionsStore>(CH.listAddBooks, listId, [book.id])
    if (next) {
      await reloadCollections()
      toast('已加入书单', 'success')
    }
    setListMenuOpen(false)
  }

  const createAndAdd = async (): Promise<void> => {
    const name = await ask({
      title: '新建书单',
      label: '书单名称',
      okText: '新建'
    })
    if (!name?.trim()) return
    const store = await window.api.invoke<CollectionsStore>(CH.listCreate, name.trim())
    await reloadCollections()
    const created = store?.lists.find((l) => l.name === name.trim())
    if (created) await addToList(created.id)
    else setListMenuOpen(false)
  }

  const fav = isFavorite(book.id)

  return (
    <div className="detail">
      <style>{METADATA_CSS}</style>
      <div className="detail-hero">
        <div className="detail-hero-bg" style={{ backgroundImage: `url(${coverUrl(book.id)})` }} />
        <div className="detail-hero-inner">
          <div className="detail-cover-wrap">
            {book.hasCover ? (
              <img className="detail-cover" src={coverUrl(book.id)} alt={book.title} />
            ) : (
              <div className="detail-cover detail-cover-empty">无封面</div>
            )}
            <button className="cover-edit" type="button" onClick={() => setCoverOpen(true)}>
              更换 / 裁剪封面
            </button>
          </div>
          <div className="detail-head">
            <div className="detail-series">
              {book.series ? `${book.series}${book.seriesIndex ? ` · 第 ${book.seriesIndex} 部` : ''}` : '未归入系列'}
            </div>
            <h1 className="detail-title">{book.title}</h1>
            <div className="detail-author">{book.authors || '佚名'}</div>
            <div className="detail-rating">
              {book.rating ? '★'.repeat(Math.round(book.rating / 2)) : '未评分'}
              {book.publisher ? <span className="dot">·</span> : null}
              {book.publisher}
              <span className="dot">·</span>
              {formatBytes(book.sizeBytes)}
            </div>

            <div className="detail-actions">
              <button className="btn btn-primary" onClick={() => navigate({ name: 'reader', id: book.id })}>
                <IconPlay width={16} height={16} />
                开始阅读
              </button>
              <button className="btn" onClick={() => openBook()}>
                <IconBook width={18} height={18} />
                用 calibre 阅读
              </button>
              <button className="btn" onClick={() => setCoverOpen(true)}>
                封面
              </button>
              <button
                className={`btn${fav ? ' is-fav' : ''}`}
                onClick={() => void onToggleFav()}
                title={fav ? '从收藏里移除' : '加入收藏'}
              >
                <IconBookmark width={18} height={18} />
                {fav ? '已收藏' : '收藏'}
              </button>
              <button className="btn" onClick={() => openBook('EPUB')}>
                <IconPlay width={16} height={16} />
                打开 EPUB
              </button>
              <button className="btn" onClick={() => navigate({ name: 'convert' })}>
                <IconConvert width={18} height={18} />
                转换
              </button>
              <button className="btn" onClick={() => navigate({ name: 'device' })}>
                <IconDevice width={18} height={18} />
                推送 Kindle
              </button>
              <button className="btn" onClick={reveal}>
                <IconFolder width={18} height={18} />
                文件夹
              </button>
            </div>

            <div className="detail-actions detail-actions-sub">
              <div className="listmenu" ref={listMenuRef}>
                <button
                  ref={triggerRef}
                  className="btn btn-sm"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    // 菜单向下展开，超出窗口底部就往上翻
                    const openUp = r.bottom + 300 > window.innerHeight
                    setMenuPos({ top: openUp ? Math.max(8, r.top - 300) : r.bottom + 6, left: r.left })
                    setListMenuOpen((v) => !v)
                  }}
                  title="把这本书加进某个书单"
                >
                  加入书单
                </button>
                {listMenuOpen
                  ? createPortal(
                      <div
                        className="listmenu-pop is-fixed"
                        ref={listMenuRef}
                        style={{ top: menuPos.top, left: menuPos.left }}
                      >
                        {collections.lists.length === 0 ? (
                          <div className="listmenu-empty">还没有书单</div>
                        ) : (
                          collections.lists.map((l) => (
                            <button
                              key={l.id}
                              className="listmenu-item"
                              onClick={() => void addToList(l.id)}
                            >
                              <span className="listmenu-name">{l.name}</span>
                              <span className="listmenu-num">{l.bookIds.length}</span>
                            </button>
                          ))
                        )}
                        <button className="listmenu-item listmenu-new" onClick={() => void createAndAdd()}>
                          ＋ 新建书单
                        </button>
                      </div>,
                      document.body
                    )
                  : null}
              </div>
              <button
                className="btn btn-sm"
                onClick={() => navigate({ name: 'editor', id: book.id })}
              >
                编辑书籍
              </button>
              <button
                className="btn btn-sm"
                disabled={busyAction !== null}
                onClick={() => void runTool('polish', CH.bookPolish, book.id)}
                title="把元数据与封面嵌进文件本身，并压缩图片"
              >
                {busyAction === 'polish' ? '打磨中…' : '打磨优化'}
              </button>
              <button
                className="btn btn-sm"
                disabled={busyAction !== null || calibreRunning}
                onClick={() => void runTool('embed', CH.bookEmbed, book.id)}
                title="把 calibre 库里的元数据写回书籍文件（kindle 等外部设备才看得到）"
              >
                {busyAction === 'embed' ? '嵌入中…' : '嵌入元数据'}
              </button>
              <button
                className="btn btn-sm"
                disabled={busyAction !== null}
                onClick={() => void runTool('export', CH.bookExport, [book.id])}
                title="把书籍文件复制到你选择的文件夹"
              >
                导出到文件夹
              </button>
              <button
                className="btn btn-sm"
                disabled={busyAction !== null}
                onClick={() => void runTool('reveal', CH.libraryRevealBook, book.id)}
              >
                <IconFolder width={14} height={14} />
                在文件夹中显示
              </button>
              <button
                className="btn btn-sm btn-danger"
                disabled={busyAction !== null || calibreRunning}
                onClick={() => void removeBook()}
                title="从 calibre 书库删除这本书及其文件"
              >
                <IconTrash width={14} height={14} />
                删除
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="detail-body">
        <div className="detail-main">
          <div className="panel">
            <div className="panel-head">
              <h3 className="panel-title">{editing ? '编辑元数据' : '简介'}</h3>
              <span className="spacer" />
              {!editing ? (
                <button className="btn btn-sm" onClick={() => setEditing(true)}>
                  编辑元数据
                </button>
              ) : null}
            </div>

            {editing ? (
              <MetadataEditor key={book.id} book={book} onCancel={() => setEditing(false)} />
            ) : (
              <div className="detail-comments">
                {htmlToText(book.comments)}
              </div>
            )}
          </div>

          {book.tags.length > 0 ? (
            <div className="panel">
              <h3 className="panel-title">标签</h3>
              <div className="tag-cloud">
                {book.tags.map((t) => (
                  <span className="chip" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <aside className="detail-side">
          <div className="panel">
            <h3 className="panel-title">元数据</h3>
            <Field label="书号">
              <code>{book.id}</code>
            </Field>
            <Field label="格式">{book.formats.join(' / ') || '—'}</Field>
            <Field label="出版社">{book.publisher || '—'}</Field>
            <Field label="语言">{book.languages || '—'}</Field>
            <Field label="出版日期">{pubdateInput(book.pubdate) || '未知'}</Field>
            <Field label="入库时间">{formatDate(book.timestamp)}</Field>
            <Field label="标识符">
              {Object.keys(book.identifiers).length ? (
                <div className="me-ids">
                  {Object.entries(book.identifiers).map(([key, value]) => (
                    <div className="me-id" key={key}>
                      <span className="me-id-k">{key}</span>
                      <span className="me-id-v">{value}</span>
                      <CopyText value={value} label={`${key.toUpperCase()} ${value}`} />
                    </div>
                  ))}
                </div>
              ) : (
                '—'
              )}
            </Field>
            <Field label="阅读进度">
              {book.posFrac != null ? `${(book.posFrac * 100).toFixed(1)}%` : '未读'}
            </Field>
            <Field label="相对路径">
              <code className="path-code">{book.relPath}</code>
            </Field>
          </div>
        </aside>
      </div>

      {coverOpen ? (
        <CoverEditor
          bookId={book.id}
          title={book.title}
          hasCover={book.hasCover}
          calibreRunning={calibreRunning}
          invoke={(c, ...a) => window.api.invoke(c, ...a)}
          onClose={() => setCoverOpen(false)}
          onSaved={(msg) => {
            toast(msg, 'success')
            void reload()
          }}
        />
      ) : null}
    </div>
  )
}

export type { Book }
