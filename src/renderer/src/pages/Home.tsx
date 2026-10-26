import { useEffect, useMemo, useRef, useState } from 'react'
import type { Book, CatalogItem, CatalogPage } from '../../../shared/types'
import { CH } from '../../../shared/ipc'
import { useApp } from '../app/context'
import { coverUrl } from '../lib/cover'
import { IconChevron } from '../icons'

function bytes(n: number): string {
  if (!n) return ''
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 封面墙里的一张小封面，本地和外部源共用 */
function WallCover({ src }: { src: string }): React.ReactElement {
  return <img className="hb-cover" src={src} alt="" width={54} height={72} draggable={false} />
}

/**
 * 一张 banner：背景是两排反向漂移的封面墙，右下角一块色板压着大标题。
 * 轨道内容复制两份 + translateX(-50%) 做无缝循环。
 */
function BannerCard({
  tone,
  word,
  sub,
  covers,
  onClick
}: {
  tone: 'green' | 'blue' | 'orange'
  word: string
  sub: string
  covers: string[]
  onClick: () => void
}): React.ReactElement {
  const list = covers.length >= 6 ? covers : covers.concat(covers, covers)
  return (
    <button type="button" className={`hb-card hb-${tone}`} onClick={onClick} title={sub}>
      <div className="hb-wall">
        <div className="hb-track">
          {list.concat(list).map((src, i) => (
            <WallCover key={`a${i}`} src={src} />
          ))}
        </div>
        <div className="hb-track hb-rev">
          {list
            .slice()
            .reverse()
            .concat(list.slice().reverse())
            .map((src, i) => (
              <WallCover key={`b${i}`} src={src} />
            ))}
        </div>
      </div>
      <div className="hb-scrim" />
      <div className="hb-plate">
        <span className="hb-word">{word}</span>
        <span className="hb-sub">{sub}</span>
      </div>
    </button>
  )
}

/** 一行书：标题 + 右箭头，下面是封面卡 */
/** 单行横滑容器：左右箭头按一屏滚动，到边自动禁用 */
function HScroll({
  children,
  className
}: {
  children: React.ReactNode
  className: string
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [atLeft, setAtLeft] = useState(true)
  const [atRight, setAtRight] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = (): void => {
      setAtLeft(el.scrollLeft <= 4)
      setAtRight(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4)
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [children])

  const slide = (dir: 1 | -1): void => {
    const el = ref.current
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' })
  }

  return (
    <div className="hscroll">
      <div className={`hscroll-track ${className}`} ref={ref}>
        {children}
      </div>
      <button
        type="button"
        className="hs-arrow is-left"
        aria-label="向左"
        disabled={atLeft}
        onClick={() => slide(-1)}
      >
        <IconChevron width={20} height={20} />
      </button>
      <button
        type="button"
        className="hs-arrow is-right"
        aria-label="向右"
        disabled={atRight}
        onClick={() => slide(1)}
      >
        <IconChevron width={20} height={20} />
      </button>
    </div>
  )
}

function Row({
  title,
  books,
  onOpen,
  onMore
}: {
  title: string
  books: Book[]
  onOpen: (b: Book) => void
  onMore: () => void
}): React.ReactElement {
  if (books.length === 0) return <></>
  return (
    <section className="home-row">
      <button type="button" className="home-row-head" onClick={onMore}>
        <span>{title}</span>
        <IconChevron width={22} height={22} />
      </button>
      <HScroll className="home-covers">
          {books.map((b) => (
            <button
              type="button"
              className="home-cover"
              key={b.id}
              onClick={() => onOpen(b)}
              title={`${b.title}${b.authors ? ` · ${b.authors}` : ''}`}
            >
              <img src={coverUrl(b.id)} alt={b.title} width={145} height={194} draggable={false} loading="lazy" />
              <span className="home-cover-title">{b.title}</span>
            </button>
          ))}
      </HScroll>
    </section>
  )
}

/** 外部源的一行：点了直接问「加不加入书库」 */
function SourceRow({
  title,
  items,
  error,
  loading,
  busyId,
  onPick
}: {
  title: string
  items: CatalogItem[]
  error?: string
  loading?: boolean
  busyId: string
  onPick: (item: CatalogItem) => void
}): React.ReactElement {
  return (
    <section className="home-row">
      <div className="home-row-head home-row-head-static">
        <span>{title}</span>
        {error ? <em className="home-row-err">{error}</em> : null}
      </div>
      {items.length === 0 ? (
        loading ? (
          <HScroll className="home-covers">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="home-skeleton" />
            ))}
          </HScroll>
        ) : null
      ) : (
        <HScroll className="home-covers">
          {items.map((it) => (
            <button
              type="button"
              className="home-cover"
              key={it.id}
              onClick={() => onPick(it)}
              title={`${it.title}${it.authors ? ` · ${it.authors}` : ''}`}
            >
              {it.cover ? (
                <img src={it.cover} alt={it.title} width={145} height={194} draggable={false} loading="lazy" />
              ) : (
                <span className="home-cover-fallback">{it.title}</span>
              )}
              <span className="home-cover-title">
                {busyId === it.id ? '正在加入…' : it.title}
              </span>
            </button>
          ))}
        </HScroll>
      )}
    </section>
  )
}

export default function Home(): React.ReactElement {
  const { books, stats, navigate, confirm, toast, reload } = useApp()

  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [loadingCatalog, setLoadingCatalog] = useState(true)

  // 首页第二行和第二张 banner 走外部书目源（古登堡），失败不影响其它部分
  useEffect(() => {
    let alive = true
    window.api
      .invoke<CatalogPage>(CH.sourcesBrowse, 'gutenberg')
      .then((page) => {
        if (!alive) return
        if (page?.error) setCatalogError(page.error)
        setCatalog((page?.items ?? []).slice(0, 9))
      })
      .catch(() => {
        if (alive) setCatalogError('连不上书目源')
      })
      .finally(() => {
        if (alive) setLoadingCatalog(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const reading = useMemo(
    () => books.filter((b) => b.posFrac != null).sort((a, b) => (b.posFrac ?? 0) - (a.posFrac ?? 0)),
    [books]
  )
  const needFix = useMemo(() => books.filter((b) => b.descLen === 0), [books])
  const picked = useMemo(() => {
    if (!books.length) return []
    const step = Math.max(1, Math.floor(books.length / 9))
    const out: Book[] = []
    for (let i = 0; i < books.length && out.length < 18; i += step) out.push(books[i])
    return out
  }, [books])

  const localCovers = useMemo(() => books.slice(0, 24).map((b) => coverUrl(b.id)), [books])
  const localCoversB = useMemo(
    () => needFix.slice(0, 24).map((b) => coverUrl(b.id)),
    [needFix]
  )
  const remoteCovers = useMemo(
    () => catalog.map((c) => c.cover).filter((c): c is string => Boolean(c)),
    [catalog]
  )

  const pickExternal = async (item: CatalogItem): Promise<void> => {
    const ok = await confirm({
      title: `把《${item.title}》加进书库？`,
      message: `${item.authors || '作者未知'}${item.sizeBytes ? ` · ${bytes(item.sizeBytes)}` : ''}\n来自 ${item.sourceName}，公共版权作品。`,
      okText: '下载'
    })
    if (!ok) return
    setBusyId(item.id)
    try {
      const res = await window.api.invoke<{ ok: boolean; message: string }>(CH.sourcesDownload, item.sourceId, item.id)
      toast(res.message || (res.ok ? '已加入书库' : '下载失败'), res.ok ? 'success' : 'error')
      if (res.ok) await reload()
    } catch (e) {
      toast(String(e), 'error')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="page page-home">
      <HScroll className="home-banners">
        <BannerCard
          tone="green"
          word="书库"
          sub={`${stats.total} 本，${stats.authors} 位作者`}
          covers={localCovers}
          onClick={() => navigate({ name: 'library' })}
        />
        <BannerCard
          tone="blue"
          word="古登堡"
          sub={catalog.length ? `公共版权 · 已取到 ${catalog.length} 本` : '公共版权·公共领域'}
          covers={remoteCovers.length ? remoteCovers : localCovers}
          onClick={() => navigate({ name: 'library' })}
        />
        <BannerCard
          tone="orange"
          word="待整理"
          sub={`${needFix.length} 本缺简介`}
          covers={localCoversB}
          onClick={() => navigate({ name: 'workbench' })}
        />
      </HScroll>

      <Row
        title="从我的书库里推荐"
        books={picked}
        onOpen={(b) => navigate({ name: 'book', id: b.id })}
        onMore={() => navigate({ name: 'library' })}
      />

      <SourceRow
        title="Project Gutenberg · 公共版权"
        items={catalog}
        error={catalogError}
        loading={loadingCatalog}
        busyId={busyId}
        onPick={(item) => void pickExternal(item)}
      />

      <Row
        title="在读"
        books={reading.slice(0, 18)}
        onOpen={(b) => navigate({ name: 'book', id: b.id })}
        onMore={() => navigate({ name: 'library' })}
      />
    </div>
  )
}
