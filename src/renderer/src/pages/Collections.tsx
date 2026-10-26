import { useEffect, useMemo, useState } from 'react'
import type { Book, CollectionsStore } from '../../../shared/types'
import { CH } from '../../../shared/ipc'
import { useApp } from '../app/context'
import { coverUrl } from '../lib/cover'
import {
  IconCheck,
  IconConvert,
  IconDevice,
  IconDownload,
  IconPlus,
  IconTrash
} from '../icons'

/** 转换页入队的返回结构（主进程 convert.ts 的 EnqueueResult） */
interface EnqueueResult {
  ok: boolean
  added: number
  skipped: number
  message?: string
}

/** calibredb export 的返回结构 */
interface ExportResult {
  ok: boolean
  message: string
}

/** 页面内样式，cl- 前缀，避免和 styles.css 抢类名 */
const CSS = `
.cl-search {
  width: 220px;
  height: 34px;
}
.cl-picker {
  margin-bottom: 16px;
}
.cl-picker-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.cl-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 12px 10px;
  max-height: 420px;
  overflow-y: auto;
  padding-right: 4px;
}
.cl-pick {
  position: relative;
  display: block;
  padding: 0;
  border: 1px solid var(--hairline-soft);
  border-radius: 8px;
  overflow: hidden;
  background: #fafafa;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
  corner-shape: squircle;
}
.cl-pick:hover:not(:disabled) {
  border-color: #cfe8da;
  box-shadow: var(--shadow-1);
}
.cl-pick:disabled {
  cursor: progress;
  opacity: 0.7;
}
.cl-pick img {
  width: 100%;
  aspect-ratio: 145 / 194;
  object-fit: cover;
  display: block;
  background: var(--surface-2);
}
.cl-pick-title {
  display: block;
  padding: 6px 8px 7px;
  font-size: 12px;
  color: var(--t3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cl-pick.is-on {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
.cl-pick-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  line-height: 1.5;
}
.cl-picker-foot {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--t2);
}
.cl-editor {
  margin-bottom: 16px;
}
.cl-editor-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.cl-name {
  width: 260px;
  height: 34px;
}
.cl-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--t2);
  line-height: 1.6;
}
.cl-join {
  margin-bottom: 16px;
}
.cl-join-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.cl-join-item {
  cursor: pointer;
  border: 1px solid var(--hairline);
  background: var(--surface);
  corner-shape: squircle;
}
.cl-join-item:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent-press);
}
.cl-join-num {
  font-size: 12px;
  color: var(--t2);
}
.cl-join-new {
  border-style: dashed;
}
.cl-missing {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  margin-bottom: 16px;
  border-radius: 10px;
  background: #fff6e8;
  color: #9a6100;
  font-size: 13px;
  corner-shape: squircle;
}
.cl-empty-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 16px;
}
.cl-foot {
  font-size: 13px;
  color: var(--t2);
  line-height: 1.7;
}
`

function dayStamp(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 收藏 / 书单页：mode='favorites' 看收藏，mode='list' 看某个书单 */
export default function Collections({
  mode,
  listId
}: {
  mode: 'favorites' | 'list'
  listId?: string
}): React.ReactElement {
  const {
    books,
    collections,
    invoke,
    reloadCollections,
    toggleFavorite,
    isFavorite,
    setSelected,
    calibreRunning,
    navigate,
    toast,
    ask,
    confirm
  } = useApp()

  const [picked, setPicked] = useState<number[]>([])
  const [keyword, setKeyword] = useState('')
  const [pickWord, setPickWord] = useState('')
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [joining, setJoining] = useState(false)
  const [busy, setBusy] = useState(false)

  // 切收藏 / 切书单时把页面内的临时状态清干净，避免上一个页面的选择残留
  useEffect(() => {
    setPicked([])
    setKeyword('')
    setPickWord('')
    setPicking(false)
    setEditing(false)
    setJoining(false)
  }, [mode, listId])

  const list = mode === 'list' ? collections.lists.find((item) => item.id === listId) : undefined
  const ids = useMemo(
    () => (mode === 'favorites' ? collections.favorites : (list?.bookIds ?? [])),
    [mode, collections.favorites, list?.bookIds]
  )

  const bookIndex = useMemo(() => {
    const map = new Map<number, Book>()
    for (const book of books) map.set(book.id, book)
    return map
  }, [books])

  // store 里可能有已经不在书库的 id（书被删 / 移走），拆成「能显示」和「失效」两组
  const { found, missing } = useMemo(() => {
    const rows: Book[] = []
    const gone: number[] = []
    for (const id of ids) {
      const book = bookIndex.get(id)
      if (book) rows.push(book)
      else gone.push(id)
    }
    return { found: rows, missing: gone }
  }, [ids, bookIndex])

  const q = keyword.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!q) return found
    return found.filter(
      (book) => book.title.toLowerCase().includes(q) || book.authors.toLowerCase().includes(q)
    )
  }, [found, q])

  const pickList = useMemo(() => {
    const word = pickWord.trim().toLowerCase()
    const matched = word
      ? books.filter(
          (book) =>
            book.title.toLowerCase().includes(word) || book.authors.toLowerCase().includes(word)
        )
      : books
    // 整个书库可能有几千本，先渲染前 120 本，剩下的用搜索缩小范围
    return { items: matched.slice(0, 120), total: matched.length }
  }, [books, pickWord])

  const otherLists = useMemo(
    () => collections.lists.filter((item) => item.id !== listId),
    [collections.lists, listId]
  )

  const allSelected = visible.length > 0 && visible.every((book) => picked.includes(book.id))

  const inCurrent = (bookId: number): boolean =>
    mode === 'favorites' ? isFavorite(bookId) : (list?.bookIds.includes(bookId) ?? false)

  const togglePick = (bookId: number): void => {
    setPicked((prev) =>
      prev.includes(bookId) ? prev.filter((id) => id !== bookId) : [...prev, bookId]
    )
  }

  const toggleAll = (): void => {
    if (allSelected) setPicked([])
    else setPicked(visible.map((book) => book.id))
  }

  /** 统一处理 IPC 异常，并保证同一时间只有一个写操作在跑 */
  const runAction = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast(`操作失败：${String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 收藏 ---------------- */

  const unfavorite = (): void => {
    const chosen = picked.slice()
    if (!chosen.length) return
    void runAction(async () => {
      for (const id of chosen) await toggleFavorite(id)
      await reloadCollections()
      setPicked([])
      toast(`已取消收藏 ${chosen.length} 本`, 'success')
    })
  }

  const cleanMissing = (): void => {
    const gone = missing.slice()
    if (!gone.length) return
    void runAction(async () => {
      if (mode === 'favorites') {
        // 失效 id 一定在收藏里，走 toggle 刚好把它们移除
        for (const id of gone) await toggleFavorite(id)
      } else if (list) {
        await invoke<CollectionsStore>(CH.listRemoveBooks, list.id, gone)
      }
      await reloadCollections()
      setPicked([])
      toast(`已清理 ${gone.length} 条失效条目`, 'success')
    })
  }

  /* ---------------- 书单 ---------------- */

  const removeFromList = (): void => {
    const target = list
    const chosen = picked.slice()
    if (!target || !chosen.length) return
    void runAction(async () => {
      await invoke<CollectionsStore>(CH.listRemoveBooks, target.id, chosen)
      await reloadCollections()
      setPicked([])
      toast(`已从「${target.name}」移除 ${chosen.length} 本`, 'success')
    })
  }

  const addToList = (targetId: string): void => {
    const chosen = picked.slice()
    const target = collections.lists.find((item) => item.id === targetId)
    if (!target || !chosen.length) return
    void runAction(async () => {
      await invoke<CollectionsStore>(CH.listAddBooks, target.id, chosen)
      await reloadCollections()
      setJoining(false)
      setPicked([])
      toast(`已把 ${chosen.length} 本加入「${target.name}」`, 'success')
    })
  }

  const createAndAdd = async (): Promise<void> => {
    const input = await ask({
      title: '新建书单',
      label: '书单名称',
      okText: '新建'
    })
    const name = input?.trim()
    if (!name) return
    const chosen = picked.slice()
    const before = new Set(collections.lists.map((item) => item.id))
    void runAction(async () => {
      const created = await invoke<CollectionsStore>(CH.listCreate, name)
      // 返回的 store 里，之前不存在的那个 id 就是刚建的书单
      const fresh = created.lists.find((item) => !before.has(item.id))
      if (fresh && chosen.length) {
        await invoke<CollectionsStore>(CH.listAddBooks, fresh.id, chosen)
      }
      await reloadCollections()
      setJoining(false)
      setPicked([])
      toast(
        fresh && chosen.length
          ? `已新建「${fresh.name}」并加入 ${chosen.length} 本`
          : `已新建书单「${fresh?.name ?? name}」`,
        'success'
      )
    })
  }

  const saveName = (): void => {
    const target = list
    if (!target) return
    const name = draftName.trim()
    if (!name) {
      toast('书单名称不能为空', 'error')
      return
    }
    if (name === target.name) {
      setEditing(false)
      return
    }
    void runAction(async () => {
      await invoke<CollectionsStore>(CH.listRename, target.id, name)
      await reloadCollections()
      setEditing(false)
      toast('书单已重命名', 'success')
    })
  }

  const removeList = async (): Promise<void> => {
    const target = list
    if (!target) return
    const yes = await confirm({
      title: `删除书单「${target.name}」？`,
      okText: '删除',
      danger: true
    })
    if (!yes) return
    void runAction(async () => {
      await invoke<CollectionsStore>(CH.listDelete, target.id)
      await reloadCollections()
      toast(`已删除书单「${target.name}」`, 'success')
      navigate({ name: 'home' })
    })
  }

  const openEditor = (): void => {
    setJoining(false)
    setDraftName(list?.name ?? '')
    setEditing(true)
  }

  /* ---------------- 批量动作 ---------------- */

  const convertBooks = (): void => {
    const chosen = picked.slice()
    if (!chosen.length) return
    void runAction(async () => {
      // 目标格式不传，主进程用设置里的默认值
      const res = await invoke<EnqueueResult>(CH.convertEnqueue, chosen)
      if (!res.ok) {
        toast(res.message ?? '入队失败', 'error')
        return
      }
      const skipped = res.skipped ? `，跳过 ${res.skipped} 本` : ''
      toast(`已加入 ${res.added} 个转换任务${skipped}`, 'success')
      setPicked([])
      navigate({ name: 'convert' })
    })
  }

  const pushToKindle = (): void => {
    const chosen = picked.slice()
    if (!chosen.length) return
    // 设备页直接读上下文里的选择，这里先把选中的书交过去
    setSelected(chosen)
    navigate({ name: 'device' })
  }

  const exportBooks = (): void => {
    const chosen = picked.slice()
    if (!chosen.length) return
    void runAction(async () => {
      const res = await invoke<ExportResult>(CH.bookExport, chosen)
      toast(res.message || (res.ok ? '已导出' : '导出失败'), res.ok ? 'success' : 'error')
    })
  }

  /** 挑选面板里点一本书：收藏页切收藏，书单页切是否在本书单里 */
  const pickToggle = (bookId: number): void => {
    if (mode === 'favorites') {
      void toggleFavorite(bookId)
      return
    }
    const target = list
    if (!target) return
    const on = target.bookIds.includes(bookId)
    void runAction(async () => {
      await invoke<CollectionsStore>(
        on ? CH.listRemoveBooks : CH.listAddBooks,
        target.id,
        [bookId]
      )
      await reloadCollections()
    })
  }

  // 书单被删掉（可能是侧栏里删的）时给一个能走掉的空页，而不是白屏
  if (mode === 'list' && !list) {
    return (
      <div className="page">
        <style>{CSS}</style>
        <div className="page-head">
          <h1 className="page-title">书单</h1>
        </div>
        <div className="empty">
          这个书单不存在，可能已经被删除了
          <div className="cl-empty-actions">
            <button className="btn" onClick={() => navigate({ name: 'home' })}>
              回首页
            </button>
            <button className="btn" onClick={() => navigate({ name: 'library' })}>
              去书库
            </button>
          </div>
        </div>
      </div>
    )
  }

  const title = mode === 'favorites' ? '收藏内容' : (list?.name ?? '书单')
  const sub =
    mode === 'favorites'
      ? `共 ${collections.favorites.length} 本${picked.length ? ` · 已选 ${picked.length}` : ''}`
      : list
        ? `共 ${list.bookIds.length} 本 · 建于 ${dayStamp(list.createdAt)}${
            picked.length ? ` · 已选 ${picked.length}` : ''
          }`
        : ''

  return (
    <div className="page">
      <style>{CSS}</style>

      <div className="page-head">
        <h1 className="page-title">{title}</h1>
        <span className="page-sub">{sub}</span>
        <span className="spacer" />
        <input
          className="input cl-search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button
          className={`btn btn-sm${picking ? ' btn-primary' : ''}`}
          onClick={() => setPicking((prev) => !prev)}
        >
          {mode === 'favorites'
            ? picking
              ? '收起挑选'
              : '挑选收藏'
            : picking
              ? '收起添加'
              : '添加书籍'}
        </button>
        {mode === 'list' ? (
          <button className="btn btn-sm" disabled={busy} onClick={openEditor}>
            编辑书单
          </button>
        ) : null}
      </div>

      {editing && list ? (
        <div className="panel cl-editor">
          <div className="cl-editor-row">
            <label className="page-sub" style={{ fontSize: 13 }}>
              书单名称
            </label>
            <input
              className="input cl-name"
              value={draftName}
              autoFocus
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={saveName}>
              保存
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
              取消
            </button>
            <span className="spacer" />
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void removeList()}>
              <IconTrash width={15} height={15} />
              删除书单
            </button>
          </div>

        </div>
      ) : null}

      {picking ? (
        <div className="panel cl-picker">
          <div className="cl-picker-head">
            <span className="panel-title" style={{ margin: 0 }}>
              {mode === 'favorites' ? '从书库挑选收藏' : `添加书籍到「${list?.name ?? '书单'}」`}
            </span>
            <input
              className="input cl-search"
              value={pickWord}
              onChange={(e) => setPickWord(e.target.value)}
            />
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setPicking(false)}>
              收起
            </button>
          </div>

          {pickList.items.length === 0 ? (
            <div className="empty" style={{ padding: '32px 0' }}>
              没有找到这本书
            </div>
          ) : (
            <div className="cl-picker-grid">
              {pickList.items.map((book) => {
                const on = inCurrent(book.id)
                return (
                  <button
                    key={book.id}
                    type="button"
                    className={`cl-pick${on ? ' is-on' : ''}`}
                    disabled={busy}
                    title={on ? '点击移出' : '点击加入'}
                    onClick={() => pickToggle(book.id)}
                  >
                    <img src={coverUrl(book.id)} alt="" loading="lazy" draggable={false} />
                    <span className="cl-pick-title">{book.title}</span>
                    {on ? (
                      <span className="cl-pick-badge">
                        {mode === 'favorites' ? '已收藏' : '已在书单'}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}

          <p className="cl-picker-foot">
            命中 {pickList.total} 本
            {pickList.total > pickList.items.length
              ? `，只显示前 ${pickList.items.length} 本，用搜索缩小范围`
              : ''}
            。点击封面即可{mode === 'favorites' ? '收藏 / 取消收藏' : '加入 / 移出书单'}。
          </p>
        </div>
      ) : null}

      {missing.length > 0 && found.length > 0 ? (
        <div className="cl-missing">
          有 {missing.length} 本已不在书库里（可能被删除或移出书库），显示时已跳过
          <span className="spacer" />
          <button className="btn btn-sm" disabled={busy} onClick={cleanMissing}>
            清理失效条目
          </button>
        </div>
      ) : null}

      {picked.length > 0 ? (
        <div className="selbar">
          <span className="selbar-count">已选 {picked.length} 本</span>
          <button className="btn btn-sm" onClick={toggleAll}>
            {allSelected ? '取消全选' : '全选当前'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setPicked([])}>
            清空
          </button>
          <span className="spacer" />
          {mode === 'favorites' ? (
            <button className="btn btn-sm" disabled={busy} onClick={unfavorite}>
              取消收藏
            </button>
          ) : (
            <button className="btn btn-sm" disabled={busy} onClick={removeFromList}>
              从书单移除
            </button>
          )}
          <button className="btn btn-sm" disabled={busy} onClick={() => setJoining((prev) => !prev)}>
            <IconPlus width={15} height={15} />
            加入书单
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={convertBooks}>
            <IconConvert width={15} height={15} />
            转换
          </button>
          <button className="btn btn-sm" onClick={pushToKindle}>
            <IconDevice width={15} height={15} />
            推送 Kindle
          </button>
          <button
            className="btn btn-sm"
            disabled={busy || calibreRunning}
            title={
              calibreRunning
                ? 'calibre 正在运行，calibredb 会拒绝导出，请先关闭 calibre'
                : '用 calibredb 导出到指定文件夹'
            }
            onClick={exportBooks}
          >
            <IconDownload width={15} height={15} />
            导出
          </button>
        </div>
      ) : null}

      {joining && picked.length > 0 ? (
        <div className="panel cl-join">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="panel-title" style={{ margin: 0, fontSize: 14 }}>
              把 {picked.length} 本加入书单
            </span>

            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setJoining(false)}>
              取消
            </button>
          </div>
          <div className="cl-join-list">
            {otherLists.map((item) => (
              <button
                key={item.id}
                className="chip cl-join-item"
                disabled={busy}
                onClick={() => addToList(item.id)}
                title={`${item.name} · 已有 ${item.bookIds.length} 本`}
              >
                {item.name}
                <span className="cl-join-num">{item.bookIds.length}</span>
              </button>
            ))}
            <button
              className="chip cl-join-item cl-join-new"
              disabled={busy}
              onClick={() => void createAndAdd()}
            >
              <IconPlus width={14} height={14} />
              新建书单并加入
            </button>
          </div>

        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="empty">
          {q ? (
            <>
              没有匹配「{keyword.trim()}」的书
              <div className="cl-empty-actions">
                <button className="btn btn-sm" onClick={() => setKeyword('')}>
                  清除搜索
                </button>
              </div>
            </>
          ) : ids.length === 0 ? (
            mode === 'favorites' ? (
              <>
                还没有收藏
                <br />
                <span style={{ fontSize: 13 }}>
                        </span>
                <div className="cl-empty-actions">
                  <button className="btn btn-primary" onClick={() => setPicking(true)}>
                    挑选收藏
                  </button>
                </div>
              </>
            ) : (
              <>
                书单「{list?.name ?? '书单'}」还是空的
                <br />
                <span style={{ fontSize: 13 }}>点「添加书籍」从书库里挑几本放进来。</span>
                <div className="cl-empty-actions">
                  <button className="btn btn-primary" onClick={() => setPicking(true)}>
                    添加书籍
                  </button>
                </div>
              </>
            )
          ) : (
            <>
              这里的书都已经不在书库里了
              <br />
              <span style={{ fontSize: 13 }}>可能被删除或移出了书库，可以清理这些失效条目。</span>
              <div className="cl-empty-actions">
                <button className="btn" disabled={busy} onClick={cleanMissing}>
                  清理失效条目
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-dense">
          {visible.map((book) => (
            <article
              key={book.id}
              className={`card${picked.includes(book.id) ? ' is-selected' : ''}`}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey || e.shiftKey) {
                  e.preventDefault()
                  togglePick(book.id)
                } else {
                  navigate({ name: 'book', id: book.id })
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                togglePick(book.id)
              }}
              title={`${book.title}\n${book.authors || '佚名'}`}
            >
              <img src={coverUrl(book.id)} alt={book.title} loading="lazy" draggable={false} />
              <div
                className="card-check"
                onClick={(e) => {
                  e.stopPropagation()
                  togglePick(book.id)
                }}
              >
                <IconCheck width={13} height={13} />
              </div>
              <div className="card-meta">
                <div className="card-title">{book.title}</div>
                <div className="card-author">{book.authors || '佚名'}</div>
              </div>
            </article>
          ))}
        </div>
      )}

      <div style={{ height: 12 }} />
      <span className="cl-foot">
        Ctrl / ⌘ 点击多选，右键也能选中。收藏和书单只保存在 eebookk 本地
        （userData/collections.json），不会写入 calibre，也不会动你的标签。
      </span>
    </div>
  )
}
