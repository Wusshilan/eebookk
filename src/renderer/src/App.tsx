import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings, CollectionsStore, ConvertJob, LibraryPayload, ShortcutSettings, TaskSnapshot, UpdateInfo
} from '../../shared/types'
import { CH } from '../../shared/ipc'
import logo from './assets/logo.svg'
import { applyAppearance, watchSystemTheme } from './lib/appearance'
import { matches, isTypingTarget } from './lib/shortcuts'
import { AppCtx, type AppApi, type Route } from './app/context'
import {
  IconBack, IconBookmark, IconClose, IconConvert, IconDevice,
  IconGear, IconGrid, IconHash, IconHome, IconMaximize, IconMinimize,
  IconMore, IconPalette, IconPlus, IconSearch, IconSliders, IconSort, IconTasks, IconUser
} from './icons'
import Toast, { useToasts } from './components/Toast'
import Dialog, { type DialogRequest } from './components/Dialog'
import BottomBar from './components/BottomBar'
import Home from './pages/Home'
import LibraryPage from './pages/Library'
import BookDetail from './pages/BookDetail'
import Workbench from './pages/Workbench'
import Convert from './pages/Convert'
import Device from './pages/Device'
import Settings from './pages/Settings'
import Tags from './pages/Tags'
import Authors from './pages/Authors'
import Collections from './pages/Collections'
import Reader from './pages/Reader'
import Editor from './pages/Editor'

interface NavItem {
  key: Route['name']
  label: string
  icon: React.ReactElement
  badge?: number
}

/** 截图校验用：允许通过 #library 这样的 hash 指定初始页面 */
const ACCENT_LIST = [
  { k: 'green', c: '#07c160' },
  { k: 'blue', c: '#1e80ff' },
  { k: 'purple', c: '#7c5cff' },
  { k: 'orange', c: '#ff7a45' },
  { k: 'rose', c: '#f43f5e' }
]

function initialRoute(): Route {
  // 允许 #book:747,cover 这种「路由 + 附加动作」的写法，附加动作由页面自己读
  const raw = window.location.hash.replace(/^#/, '').trim().split(',')[0]
  if (!raw) return { name: 'home' }
  if (raw.startsWith('book:')) {
    const id = Number(raw.slice(5))
    return Number.isFinite(id) ? { name: 'book', id } : { name: 'home' }
  }
  if (raw.startsWith('list:')) {
    const id = raw.slice(5)
    return id ? { name: 'list', id } : { name: 'home' }
  }
  if (raw.startsWith('editor:')) {
    const id = Number(raw.slice(7))
    return Number.isFinite(id) ? { name: 'editor', id } : { name: 'home' }
  }
  if (raw.startsWith('reader:')) {
    const id = Number(raw.slice(7))
    return Number.isFinite(id) ? { name: 'reader', id } : { name: 'home' }
  }
  const names = [
    'home', 'library', 'workbench', 'convert', 'device', 'settings',
    'tags', 'authors', 'favorites'
  ]
  return names.includes(raw) ? ({ name: raw } as Route) : { name: 'home' }
}

export default function App(): React.ReactElement {
  const [payload, setPayload] = useState<LibraryPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stack, setStack] = useState<Route[]>(() => {
    const first = initialRoute()
    return first.name === 'home' ? [first] : [{ name: 'home' }, first]
  })
  const [selected, setSelected] = useState<number[]>([])
  const [search, setSearch] = useState('')
  const [toasts, toast] = useToasts()
  const [calibreRunning, setCalibreRunning] = useState(false)
  const [convertRunning, setConvertRunning] = useState(0)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [collections, setCollections] = useState<CollectionsStore>({ favorites: [], lists: [] })
  const [listSort, setListSort] = useState<'count' | 'name'>('count')
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  /** 内置阅读器记录的进度，优先于 calibre 自己的 pos_frac */
  const [readPos, setReadPos] = useState<Record<string, number>>({})
  const [themeOpen, setThemeOpen] = useState(false)
  const [taskOpen, setTaskOpen] = useState(false)
  const [tasks, setTasks] = useState<ConvertJob[]>([])
  const taskBoxRef = useRef<HTMLDivElement>(null)
  const [shortcuts, setShortcuts] = useState<ShortcutSettings | null>(null)
  const [accent, setAccent] = useState<string>('green')
  const themeBoxRef = useRef<HTMLDivElement>(null)
  /** 跟随系统时，系统换主题要能实时生效 */
  const appearanceRef = useRef<ReturnType<typeof Object> | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const route = stack[stack.length - 1]

  const reload = useCallback(async () => {
    const p = await window.api.invoke<LibraryPayload>(CH.libraryReload)
    setPayload(p)
    setCalibreRunning(p.calibreRunning)
  }, [])

  const refreshEnv = useCallback(async () => {
    const running = await window.api.invoke<boolean>(CH.envCalibreRunning)
    setCalibreRunning(running)
    return
  }, [])

  useEffect(() => {
    window.api
      .invoke<LibraryPayload>(CH.libraryLoad)
      .then((p) => {
        setPayload(p)
        setCalibreRunning(p.calibreRunning)
      })
      .catch((e: unknown) => setError(String(e)))
  }, [])

  // calibre 进程状态轮询：它一跑起来，所有写入就锁死
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const running = await window.api.invoke<boolean>(CH.envCalibreRunning)
        if (alive) setCalibreRunning(running)
      } catch {
        /* ignore */
      }
    }
    const timer = setInterval(tick, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  useEffect(
    () =>
      window.api.on(CH.evtTasks, (snap) => {
        const s = snap as TaskSnapshot
        const list = s.converts ?? []
        setTasks(list)
        setConvertRunning(list.filter((j) => j.status === 'running' || j.status === 'queued').length)
      }),
    []
  )

  // 版本检查：只有真的检测到更高版本，侧栏才会出现「更新」角标
  useEffect(() => {
    window.api
      .invoke<UpdateInfo>(CH.updateCheck)
      .then((info) => setUpdate(info))
      .catch(() => setUpdate(null))
  }, [])

  const reloadCollections = useCallback(async () => {
    try {
      const next = await window.api.invoke<CollectionsStore>(CH.collectionsGet)
      setCollections(next ?? { favorites: [], lists: [] })
    } catch {
      /* 主进程未就绪时忽略 */
    }
  }, [])

  useEffect(() => {
    void reloadCollections()
    return window.api.on(CH.evtCollections, () => void reloadCollections())
  }, [reloadCollections])

  const toggleFavorite = useCallback(async (bookId: number) => {
    const next = await window.api.invoke<CollectionsStore | null>(CH.favoriteToggle, bookId)
    if (next) setCollections(next)
  }, [])

  /** 应用内确认框，替代 window.confirm */
  const confirm = useCallback(
    (opts: { title: string; message?: string; okText?: string; cancelText?: string; danger?: boolean }) =>
      new Promise<boolean>((resolve) => {
        setDialog({
          kind: 'confirm',
          ...opts,
          resolve: (v) => resolve(v === true)
        })
      }),
    []
  )

  /** 应用内输入框，替代 window.prompt；取消返回 null */
  const ask = useCallback(
    (opts: {
      title: string
      message?: string
      label?: string
      defaultValue?: string
      placeholder?: string
      okText?: string
    }) =>
      new Promise<string | null>((resolve) => {
        setDialog({
          kind: 'prompt',
          ...opts,
          resolve: (v) => resolve(typeof v === 'string' ? v : null)
        })
      }),
    []
  )

  const isFavorite = useCallback(
    (bookId: number) => collections.favorites.includes(bookId),
    [collections.favorites]
  )

  /** 侧栏书单排序：默认按本数，点排序图标切到按名称 */
  const sortedLists = useMemo(() => {
    const arr = [...collections.lists]
    arr.sort((a, b) =>
      listSort === 'name' ? a.name.localeCompare(b.name, 'zh') : b.bookIds.length - a.bookIds.length
    )
    return arr
  }, [collections.lists, listSort])

  // 外观设置落到 CSS 变量；顺带处理「启动时恢复上次页面」
  const TOP_LEVEL = useMemo(
    () => ['home', 'library', 'workbench', 'convert', 'device', 'tags', 'authors', 'favorites'],
    []
  )

  useEffect(() => {
    window.api
      .invoke<AppSettings | null>(CH.settingsGet)
      .then((s) => {
        applyAppearance(s?.appearance)
        appearanceRef.current = (s?.appearance ?? null) as never
        setShortcuts(s?.shortcuts ?? null)
        setAccent(s?.appearance?.accent ?? 'green')
        if (!s?.general?.restoreLastPage) return
        // 首帧就是 hash 指定的页面时，不要再用「上次页面」把它盖掉（深链接/截图都靠这个）
        if (initialRoute().name !== 'home') return
        // 带了 #hash 说明是深链接（截图/外部调用），优先尊重 hash，不恢复上次页面
        if (window.location.hash.replace(/^#/, '').trim()) return
        const last = localStorage.getItem('eebookk.lastRoute')
        if (last && last !== 'home' && TOP_LEVEL.includes(last)) {
          setStack([{ name: 'home' }, { name: last } as Route])
        }
      })
      .catch(() => applyAppearance(null))
  }, [TOP_LEVEL])

  useEffect(() => {
    if (TOP_LEVEL.includes(route.name)) localStorage.setItem('eebookk.lastRoute', route.name)
  }, [route.name, TOP_LEVEL])

  const createList = async (): Promise<void> => {
    const name = await ask({
      title: '新建书单',
      label: '书单名称',
      okText: '创建'
    })
    if (!name?.trim()) return
    const next = await window.api.invoke<CollectionsStore>(CH.listCreate, name.trim())
    if (next) setCollections(next)
  }

  const deleteList = async (id: string, name: string): Promise<void> => {
    const yes = await confirm({
      title: `删除书单「${name}」？`,
      message: '只删书单，不会删除书籍文件。',
      okText: '删除',
      danger: true
    })
    if (!yes) return
    const next = await window.api.invoke<CollectionsStore>(CH.listDelete, id)
    if (next) setCollections(next)
    if (route.name === 'list' && route.id === id) navigate({ name: 'home' })
  }



  const navigate = useCallback((r: Route) => {
    // 注意：不要在这里清空 selection。
    // 「书库里选一批书 → 去转换 / 去推送」是主要流程，清掉选择会让批量操作做不到。
    // 选择只在用户显式清空、或批量操作成功后清。
    setStack((prev) => {
      const top = prev[prev.length - 1]
      if (top.name === r.name && JSON.stringify(top) === JSON.stringify(r)) return prev
      return [...prev, r]
    })
  }, [])

  const back = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }, [])

  useEffect(() => {
    if (!shortcuts) return
    const onKey = (e: KeyboardEvent): void => {
      const typing = isTypingTarget(e.target)
      // 搜索键在输入框里也要能用（再次聚焦）
      if (matches(e, shortcuts.search)) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (typing) return
      if (matches(e, shortcuts.home)) {
        e.preventDefault()
        navigate({ name: 'home' })
      } else if (matches(e, shortcuts.library)) {
        e.preventDefault()
        navigate({ name: 'library' })
      } else if (matches(e, shortcuts.workbench)) {
        e.preventDefault()
        navigate({ name: 'workbench' })
      } else if (matches(e, shortcuts.convert)) {
        e.preventDefault()
        navigate({ name: 'convert' })
      } else if (matches(e, shortcuts.device)) {
        e.preventDefault()
        navigate({ name: 'device' })
      } else if (matches(e, shortcuts.settings)) {
        e.preventDefault()
        navigate({ name: 'settings' })
      } else if (matches(e, shortcuts.theme)) {
        e.preventDefault()
        const cur = (appearanceRef.current as { theme?: string } | null) ?? {}
        const next = { ...cur, theme: cur.theme === 'dark' ? 'light' : 'dark' }
        applyAppearance(next as never)
        appearanceRef.current = next as never
        void window.api.invoke(CH.settingsSet, { appearance: next }).catch(() => undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcuts, navigate])

  useEffect(
    () =>
      watchSystemTheme(() => {
        const a = appearanceRef.current
        if (a) applyAppearance(a as never)
      }),
    []
  )

  useEffect(() => {
    if (!themeOpen && !taskOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (themeBoxRef.current && !themeBoxRef.current.contains(t)) setThemeOpen(false)
      if (taskBoxRef.current && !taskBoxRef.current.contains(t)) setTaskOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setThemeOpen(false)
        setTaskOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [themeOpen, taskOpen])

  /** 顶栏改主题时必须基于最新的外观，否则会把设置页刚改的主题色/圆角覆盖回去 */
  const currentAppearance = (): Record<string, unknown> => {
    try {
      const raw = localStorage.getItem('eebookk.appearance')
      if (raw) return JSON.parse(raw) as Record<string, unknown>
    } catch {
      /* 缓存坏了就用内存里的 */
    }
    return (appearanceRef.current as Record<string, unknown> | null) ?? {}
  }

  const pickTheme = async (t: 'light' | 'dark' | 'system'): Promise<void> => {
    const next = { ...currentAppearance(), theme: t }
    applyAppearance(next as never)
    appearanceRef.current = next as never
    setThemeOpen(false)
    await window.api.invoke(CH.settingsSet, { appearance: next }).catch(() => undefined)
  }

  const pickAccent = async (k: string): Promise<void> => {
    const next = { ...currentAppearance(), accent: k }
    applyAppearance(next as never)
    appearanceRef.current = next as never
    setAccent(k)
    await window.api.invoke(CH.settingsSet, { appearance: next }).catch(() => undefined)
  }

  const stats = payload?.stats
  const issueCount = stats ? stats.total - stats.withDesc : 0

  useEffect(() => {
    window.api
      .invoke<Record<string, number>>(CH.readerProgress)
      .then((map) => {
        if (map && typeof map === 'object') setReadPos(map)
      })
      .catch(() => undefined)
    return window.api.on(CH.evtReading, (value) => {
      const v = value as { bookId?: number; frac?: number }
      if (typeof v?.bookId === 'number' && typeof v?.frac === 'number') {
        setReadPos((prev) => ({ ...prev, [String(v.bookId)]: v.frac as number }))
      }
    })
  }, [])

  // 本应用的阅读进度合并进书籍列表：底部常驻条、首页「在读」都用它
  // 只给阅读进度变了的书新建对象，其余保持同一引用，避免 300 多张卡片整体重渲染
  const mergedBooks = useMemo(() => {
    if (!payload) return []
    return payload.books.map((b) => {
      const frac = readPos[String(b.id)]
      return frac != null && frac !== b.posFrac ? { ...b, posFrac: frac } : b
    })
  }, [payload, readPos])

  const nav: NavItem[] = [
    { key: 'home', label: '首页', icon: <IconHome /> },
    { key: 'library', label: '书库', icon: <IconGrid /> },
    { key: 'workbench', label: '整理台', icon: <IconSliders />, badge: issueCount },
    { key: 'convert', label: '转换', icon: <IconConvert />, badge: convertRunning || undefined },
    { key: 'device', label: '设备', icon: <IconDevice /> }
  ]
  const browse: NavItem[] = [
    { key: 'tags', label: '分组/标签', icon: <IconHash /> },
    { key: 'authors', label: '作者', icon: <IconUser /> },
    { key: 'favorites', label: '收藏内容', icon: <IconBookmark /> }
  ]

  const api: AppApi = useMemo(() => {
    const emptyPayload: LibraryPayload = {
      path: '',
      calibreVersion: null,
      calibreRunning: false,
      stats: {
        total: 0, withDesc: 0, withTags: 0, withSeries: 0, withRating: 0,
        withCover: 0, withIdentifier: 0, epub: 0, started: 0,
        tags: 0, authors: 0, series: 0, publishers: 0
      },
      books: []
    }
    const p = payload ?? emptyPayload
    return {
      payload: p,
      books: mergedBooks,
      stats: p.stats,
      reload,
      route,
      navigate,
      back,
      canBack: stack.length > 1,
      selected,
      setSelected,
      toggleSelected: (id: number) =>
        setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
      clearSelection: () => setSelected([]),
      toast,
      invoke: (channel: string, ...args: unknown[]) => window.api.invoke(channel, ...args),
      search,
      setSearch,
      calibreRunning,
      refreshEnv,
      collections,
      reloadCollections,
      toggleFavorite,
      isFavorite,
      confirm,
      ask
    }
  }, [
    payload, mergedBooks, route, navigate, back, stack.length, selected, search, toast,
    calibreRunning, reload, refreshEnv, collections, reloadCollections, toggleFavorite, isFavorite,
    confirm, ask
  ])

  if (error) return <div className="boot-error">书库读取失败：{error}</div>
  if (!payload) return <div className="boot-loading" />
  // 只有「根本没找到书库」才算启动失败；空书库是正常状态（内置 calibre 首次启动就是空的）
  if (!payload.path) {
    return (
      <div className="boot-error">
        没有找到 calibre 书库。
        <br />
        请确认 calibre 已就绪，或在设置里指定 metadata.db 所在的目录。
        <br />
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate({ name: 'settings' })}>
          去设置书库路径
        </button>
      </div>
    )
  }

  const activeKey: string = route.name === 'book' ? 'library' : route.name

  return (
    <AppCtx.Provider value={api}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <img className="brand-mark" src={logo} alt="eebookk logo" draggable={false} />
            <div className="brand-text">
              <div className="brand-name">
                eebookk
                {update?.hasUpdate ? (
                  <button
                    className="badge badge-update"
                    type="button"
                    title={update.latest ? `发现新版本 ${update.latest}（当前 ${update.current}）` : '发现新版本'}
                    onClick={() => {
                      if (update.url) void window.api.invoke(CH.openExternal, update.url)
                      else navigate({ name: 'settings' })
                    }}
                  >
                    更新
                  </button>
                ) : null}
              </div>
              <div className="brand-sub">Powered by calibre</div>
            </div>
          </div>

          <nav className="nav">
            {nav.map((item) => (
              <div
                key={item.key}
                className={`nav-item${activeKey === item.key ? ' is-active' : ''}`}
                onClick={() => {
                  setSearch('')
                  navigate({ name: item.key } as Route)
                }}
              >
                <span className="ic">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
                {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
              </div>
            ))}
          </nav>

          <div className="sep" />

          <nav className="nav nav-secondary">
            {browse.map((item) => (
              <div
                key={item.key}
                className={`nav-item${activeKey === item.key ? ' is-active' : ''}`}
                onClick={() => {
                  setSearch('')
                  navigate({ name: item.key } as Route)
                }}
              >
                <span className="ic">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </div>
            ))}
          </nav>

          <div className="sep" />

          <div className="booklist">
            <div className="booklist-head">
              <span>创建的书单</span>
              <span className="bl-count">{collections.lists.length}</span>
              <span className="spacer" />
              <span
                className="bl-tool"
                title={listSort === 'count' ? '当前按本数排序 · 点击改为按名称' : '当前按名称排序 · 点击改为按本数'}
                onClick={() => setListSort((v) => (v === 'count' ? 'name' : 'count'))}
              >
                <IconSort />
              </span>
              <span className="bl-tool" title="新建书单" onClick={() => void createList()}>
                <IconPlus />
              </span>
            </div>
            <div className="bllist">
              {collections.lists.length === 0 ? (
                <div className="bl-empty" onClick={() => void createList()}>
                  还没有书单，点 + 新建
                </div>
              ) : (
                sortedLists.map((list) => (
                  <div
                    key={list.id}
                    className={`bl-item${route.name === 'list' && route.id === list.id ? ' is-active' : ''}`}
                    onClick={() => navigate({ name: 'list', id: list.id })}
                    title={`${list.name} · ${list.bookIds.length} 本`}
                  >
                    <span className="bl-title">{list.name}</span>
                    <span className="bl-num">{list.bookIds.length}</span>
                    <span
                      className="bl-more"
                      onClick={(e) => {
                        e.stopPropagation()
                        void deleteList(list.id, list.name)
                      }}
                    >
                      <IconMore />
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

        <main className="main">
          <header className="topbar">
            <button
              className="back"
              type="button"
              aria-label="返回"
              disabled={stack.length <= 1}
              style={{ opacity: stack.length <= 1 ? 0.35 : 1 }}
              onClick={back}
            >
              <IconBack />
            </button>
            <div className="search">
              <IconSearch />
              <input
                ref={searchRef}
                title="搜索书名、作者、标签（Ctrl+K）"
                className="search-input"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  if (e.target.value && route.name !== 'library') navigate({ name: 'library' })
                }}
              />
              {search ? (
                <button className="search-clear" onClick={() => setSearch('')} aria-label="清除">
                  <IconClose width={14} height={14} />
                </button>
              ) : null}
            </div>

            <div className="top-actions">
              {calibreRunning ? (
                <span className="lock-pill" title="calibre 正在运行，此时无法写入书库">
                  编辑已锁定
                </span>
              ) : null}
              <div className="topbar-tools">
                <div className="icon-wrap" ref={themeBoxRef}>
                  <button
                    className={`icon-btn${themeOpen ? ' is-on' : ''}`}
                    type="button"
                    aria-label="主题"
                    title="主题"
                    onClick={() => setThemeOpen((v) => !v)}
                  >
                    <IconPalette />
                  </button>
                  {themeOpen ? (
                    <div className="icon-pop">
                      {[
                        { k: 'light', t: '浅色' },
                        { k: 'dark', t: '深色' },
                        { k: 'system', t: '跟随系统' }
                      ].map((item) => (
                        <button
                          key={item.k}
                          type="button"
                          className="icon-pop-item"
                          onClick={() => void pickTheme(item.k as 'light')}
                        >
                          {item.t}
                        </button>
                      ))}
                      <div className="icon-pop-sep" />
                      <div className="icon-pop-accents">
                        {ACCENT_LIST.map((a) => (
                          <button
                            key={a.k}
                            type="button"
                            className={`accent-dot${accent === a.k ? ' is-on' : ''}`}
                            style={{ background: a.c }}
                            aria-label={a.k}
                            onClick={() => void pickAccent(a.k)}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="icon-wrap" ref={taskBoxRef}>
                  <button
                    className={`icon-btn${taskOpen ? ' is-on' : ''}`}
                    type="button"
                    aria-label="任务"
                    title="任务"
                    onClick={() => setTaskOpen((v) => !v)}
                  >
                    <IconTasks />
                    {convertRunning > 0 ? <span className="icon-dot" /> : null}
                  </button>
                  {taskOpen ? (
                    <div className="icon-pop icon-pop-task">
                      <div className="task-pop-head">任务</div>
                      {tasks.filter((t) => t.status === 'running' || t.status === 'queued').length === 0 ? (
                        <div className="task-pop-empty">没有进行中的任务</div>
                      ) : (
                        tasks
                          .filter((t) => t.status === 'running' || t.status === 'queued')
                          .slice(0, 6)
                          .map((t) => (
                            <div className="task-pop-item" key={t.id}>
                              <span className="task-pop-title" title={t.title}>{t.title}</span>
                              <span className="task-pop-bar">
                                <i style={{ width: `${Math.max(3, t.percent)}%` }} />
                              </span>
                              <span className="task-pop-pct">
                                {t.status === 'queued' ? '排队' : `${Math.round(t.percent)}%`}
                              </span>
                            </div>
                          ))
                      )}
                      <button
                        type="button"
                        className="icon-pop-item task-pop-more"
                        onClick={() => {
                          setTaskOpen(false)
                          navigate({ name: 'convert' })
                        }}
                      >
                        转换队列
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="设置"
                  title="设置"
                  onClick={() => navigate({ name: 'settings' })}
                >
                  <IconGear />
                </button>
              </div>
              <div className="wincontrols">
                <button className="win-btn" type="button" onClick={() => window.api.minimize()} aria-label="最小化">
                  <IconMinimize />
                </button>
                <button className="win-btn" type="button" onClick={() => window.api.maximize()} aria-label="最大化">
                  <IconMaximize />
                </button>
                <button className="win-btn is-close" type="button" onClick={() => window.api.close()} aria-label="关闭">
                  <IconClose />
                </button>
              </div>
            </div>
          </header>

          <div className="view">
            {route.name === 'home' && <Home />}
            {route.name === 'library' && <LibraryPage />}
            {route.name === 'book' && <BookDetail id={route.id} />}
            {route.name === 'workbench' && <Workbench />}
            {route.name === 'convert' && <Convert />}
            {route.name === 'device' && <Device />}
            {route.name === 'settings' && <Settings />}
            {route.name === 'tags' && <Tags />}
            {route.name === 'authors' && <Authors />}
            {route.name === 'favorites' && <Collections mode="favorites" />}
            {route.name === 'list' && <Collections mode="list" listId={route.id} />}
            {route.name === 'reader' && <Reader id={route.id} />}
            {route.name === 'editor' && <Editor id={route.id} />}
          </div>

          <BottomBar />
        </main>
      </div>
      <Toast items={toasts} />
      {dialog ? <Dialog req={dialog} onDone={() => setDialog(null)} /> : null}
    </AppCtx.Provider>
  )
}
