import { useCallback, useEffect, useRef, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { ReaderInfo } from '../../../shared/types'
import { useApp } from '../app/context'
import { IconBack, IconRows } from '../icons'

/**
 * 内置阅读器。
 *
 * 章节装在 iframe 里，地址是 epubres://<bookId>/<包内路径>。iframe 与渲染进程
 * 不同源（父页面拿不到它的 document），所以字号、主题、滚动位置都通过
 * postMessage 往返：主进程在返回章节 HTML 时已经把样式和一小段脚本注进去了。
 */

type Theme = 'light' | 'paper' | 'dark'

const THEMES: { key: Theme; label: string }[] = [
  { key: 'light', label: '白色' },
  { key: 'paper', label: '米黄' },
  { key: 'dark', label: '深色' }
]

const MIN_FS = 15
const MAX_FS = 30

function readNum(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    // 没存过时 getItem 是 null，Number(null) 会变成 0，这里必须先挡掉
    if (raw == null || raw.trim() === '') return fallback
    const n = Number(raw)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  } catch {
    return fallback
  }
}

function readTheme(): Theme {
  try {
    const v = localStorage.getItem('eebookk.reader.theme')
    return v === 'paper' || v === 'dark' ? v : 'light'
  } catch {
    return 'light'
  }
}

function readToc(): boolean {
  try {
    return localStorage.getItem('eebookk.reader.toc') !== '0'
  } catch {
    return true
  }
}

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p).replace(/^\/+/, '')
  } catch {
    return p.replace(/^\/+/, '')
  }
}

/** 章节地址。字号/主题烘进 query，首帧就是对的；fr 只在恢复位置时带上 */
function chapterUrl(
  base: string,
  href: string,
  fs: number,
  theme: Theme,
  sub: number,
  seq: number
): string {
  const params = new URLSearchParams()
  params.set('fs', String(fs))
  params.set('theme', theme)
  params.set('n', String(seq))
  if (sub > 0.002) params.set('fr', sub.toFixed(4))
  return `${base}${href}?${params.toString()}`
}

export default function Reader({ id }: { id: number }): React.ReactElement {
  const { books, back } = useApp()
  const book = books.find((b) => b.id === id)

  const [info, setInfo] = useState<ReaderInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [fontSize, setFontSize] = useState(() => readNum('eebookk.reader.fs', 19, MIN_FS, MAX_FS))
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [tocOpen, setTocOpen] = useState(readToc)
  const [frameSrc, setFrameSrc] = useState<string | null>(null)

  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const infoRef = useRef<ReaderInfo | null>(null)
  const indexRef = useRef(0)
  const subRef = useRef(0)
  const cfgRef = useRef({ fs: fontSize, theme })
  const seqRef = useRef(0)
  const dirtyRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const flushRef = useRef<() => void>(() => {})

  const flush = useCallback(() => {
    if (!dirtyRef.current) return
    const current = infoRef.current
    if (!current || current.spine.length === 0) return
    dirtyRef.current = false
    const n = current.spine.length
    const frac = Math.min(1, Math.max(0, (indexRef.current + subRef.current) / n))
    void window.api
      .invoke(CH.readerSaveProgress, id, {
        index: indexRef.current,
        sub: subRef.current,
        frac
      })
      .catch(() => {
        /* 进度没存上不打断阅读 */
      })
  }, [id])

  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    if (timerRef.current != null) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      flushRef.current()
    }, 1200)
  }, [])

  // 离开阅读器（或换书）时把最后一次位置落盘
  useEffect(
    () => () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      flushRef.current()
    },
    []
  )

  // 打开一本书：解包、拿目录、算出上次读到哪一节
  useEffect(() => {
    let alive = true
    setLoading(true)
    setFailure(null)
    setInfo(null)
    setFrameSrc(null)
    infoRef.current = null
    indexRef.current = 0
    subRef.current = 0

    window.api
      .invoke<ReaderInfo>(CH.readerInfo, id)
      .then((next) => {
        if (!alive) return
        setLoading(false)
        if (!next) {
          setFailure('主进程没有返回这本书的信息。')
          return
        }
        infoRef.current = next
        setInfo(next)
        if (next.error) {
          setFailure(next.error)
          return
        }
        const total = next.spine.length
        if (total === 0) {
          setFailure('这本书里没有找到章节。')
          return
        }
        const pos =
          next.posFrac == null ? 0 : Math.min(total - 0.000001, Math.max(0, next.posFrac * total))
        const startIndex = Math.floor(pos)
        const sub = next.posFrac == null ? 0 : Math.max(0, Math.min(1, pos - startIndex))
        indexRef.current = startIndex
        subRef.current = sub
        setIndex(startIndex)
        seqRef.current += 1
        setFrameSrc(
          chapterUrl(next.base, next.spine[startIndex].href, cfgRef.current.fs, cfgRef.current.theme, sub, seqRef.current)
        )
        // 进来就记一笔，别等读者先滚动
        scheduleSave()
      })
      .catch((e: unknown) => {
        if (!alive) return
        setLoading(false)
        setFailure(`没能读到这本书：${String(e)}`)
      })

    return () => {
      alive = false
    }
  }, [id, scheduleSave])

  // 字号 / 主题落 localStorage，并把最新值记到 ref（换章时要用）
  useEffect(() => {
    cfgRef.current = { fs: fontSize, theme }
    try {
      localStorage.setItem('eebookk.reader.fs', String(fontSize))
    } catch {
      /* 隐私模式下存不了，不影响当前会话 */
    }
  }, [fontSize, theme])

  useEffect(() => {
    try {
      localStorage.setItem('eebookk.reader.theme', theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem('eebookk.reader.toc', tocOpen ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [tocOpen])

  const post = useCallback((msg: unknown) => {
    const el = frameRef.current
    if (!el) return
    try {
      el.contentWindow?.postMessage(msg, '*')
    } catch {
      /* 换章瞬间 window 可能已经换掉 */
    }
  }, [])

  // 字号/主题即时生效，不重载章节（否则会掉位置）
  useEffect(() => {
    post({ type: 'rd:config', fs: fontSize, theme })
  }, [fontSize, theme, post])

  const loadChapter = useCallback(
    (target: number, sub: number) => {
      const current = infoRef.current
      if (!current || current.spine.length === 0) return
      const next = Math.min(current.spine.length - 1, Math.max(0, target))
      indexRef.current = next
      subRef.current = sub
      setIndex(next)
      seqRef.current += 1
      setFrameSrc(
        chapterUrl(current.base, current.spine[next].href, cfgRef.current.fs, cfgRef.current.theme, sub, seqRef.current)
      )
      dirtyRef.current = true
      flushRef.current()
    },
    []
  )

  const goPrev = useCallback(() => loadChapter(indexRef.current - 1, 0), [loadChapter])
  const goNext = useCallback(() => loadChapter(indexRef.current + 1, 0), [loadChapter])

  const handleKey = useCallback(
    (key: string) => {
      if (key === 'ArrowLeft') goPrev()
      else if (key === 'ArrowRight') goNext()
      else if (key === 'Escape') back()
    },
    [goPrev, goNext, back]
  )

  // iframe 里的消息：滚动位置、章节内跳转、按键、外链
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || e.source !== frame.contentWindow) return
      const data = e.data as
        | { type?: unknown; frac?: unknown; path?: unknown; key?: unknown; url?: unknown }
        | null
      if (!data || typeof data.type !== 'string') return

      if (data.type === 'rd:scroll') {
        if (typeof data.frac === 'number' && Number.isFinite(data.frac)) {
          subRef.current = Math.min(1, Math.max(0, data.frac))
          scheduleSave()
        }
        return
      }
      if (data.type === 'rd:ready') {
        // 书里点脚注之类的站内链接会让 iframe 自己换页，这里把当前章同步过来
        const current = infoRef.current
        if (current && typeof data.path === 'string') {
          const path = decodePath(data.path)
          const found = current.spine.findIndex((item) => decodePath(item.href) === path)
          if (found >= 0 && found !== indexRef.current) {
            indexRef.current = found
            subRef.current = 0
            setIndex(found)
            scheduleSave()
          }
        }
        post({ type: 'rd:config', fs: cfgRef.current.fs, theme: cfgRef.current.theme })
        return
      }
      if (data.type === 'rd:key') {
        if (typeof data.key === 'string') handleKey(data.key)
        return
      }
      if (data.type === 'rd:external') {
        if (typeof data.url === 'string' && /^(https?|mailto):/i.test(data.url)) {
          void window.api.invoke(CH.openExternal, data.url)
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [handleKey, post, scheduleSave])

  // 焦点在本页时也要能用方向键 / Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Escape') {
        e.preventDefault()
        handleKey(e.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleKey])

  // 目录里把当前章滚到可见处
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [index, tocOpen])

  const total = info?.spine.length ?? 0
  const percent = total > 0 ? Math.round((index / total) * 100) : 0
  const title = info?.title || book?.title || `书 ${id}`
  const authors = info?.authors || book?.authors || '佚名'

  return (
    <div className="rd" data-theme={theme}>
      <style>{RD_CSS}</style>

      <div className="rd-bar">
        <button className="rd-tool" type="button" title="返回（Esc）" onClick={back}>
          <IconBack width={20} height={20} />
        </button>
        <button
          className={`rd-tool${tocOpen ? ' is-on' : ''}`}
          type="button"
          title={tocOpen ? '收起目录' : '展开目录'}
          onClick={() => setTocOpen((v) => !v)}
          disabled={!info}
        >
          <IconRows width={19} height={19} />
        </button>

        <div className="rd-meta">
          <div className="rd-title" title={title}>
            {title}
          </div>
          <div className="rd-sub" title={authors}>
            {authors}
            {total > 0 ? ` · ${total} 节 · ${percent}%` : ''}
          </div>
        </div>

        <span className="rd-spacer" />

        {total > 0 ? (
          <div className="rd-group">
            <button className="btn btn-sm" type="button" disabled={index <= 0} onClick={goPrev} title="上一章（←）">
              上一章
            </button>
            <span className="rd-count">
              {index + 1} / {total}
            </span>
            <button
              className="btn btn-sm"
              type="button"
              disabled={index >= total - 1}
              onClick={goNext}
              title="下一章（→）"
            >
              下一章
            </button>
          </div>
        ) : null}

        {total > 0 ? (
          <div className="rd-group">
            <button
              className="rd-tool rd-fs-btn"
              type="button"
              title="缩小字号"
              onClick={() => setFontSize((v) => Math.max(MIN_FS, v - 1))}
            >
              A<small>-</small>
            </button>
            <span className="rd-fs">{fontSize}</span>
            <button
              className="rd-tool rd-fs-btn"
              type="button"
              title="放大字号"
              onClick={() => setFontSize((v) => Math.min(MAX_FS, v + 1))}
            >
              A<small>+</small>
            </button>
          </div>
        ) : null}

        {total > 0 ? (
          <div className="rd-themes">
            {THEMES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`rd-dot${theme === item.key ? ' is-on' : ''}`}
                data-t={item.key}
                title={item.label}
                aria-label={item.label}
                onClick={() => setTheme(item.key)}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="rd-body">
        {tocOpen && info && !failure ? (
          <aside className="rd-toc">
            <div className="rd-toc-head">
              <span>目录</span>
              <span>{total} 节</span>
            </div>
            {info.spine.map((item, i) => (
              <button
                key={`${i}-${item.href}`}
                ref={i === index ? activeRef : undefined}
                type="button"
                className={`rd-toc-item${i === index ? ' is-active' : ''}`}
                title={item.label}
                onClick={() => loadChapter(i, 0)}
              >
                <span className="rd-toc-num">{i + 1}</span>
                <span className="rd-toc-label">{item.label}</span>
              </button>
            ))}
          </aside>
        ) : null}

        <div className="rd-stage">
          {loading ? <div className="rd-empty">正在解包 EPUB…</div> : null}

          {!loading && failure ? (
            <div className="rd-fail">
              <div className="rd-fail-title">这本书打不开</div>
              <p className="rd-fail-msg">{failure}</p>
              <div className="rd-fail-actions">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void window.api.invoke(CH.libraryOpenBook, id)}
                >
                  用系统阅读器打开
                </button>
                <button className="btn" type="button" onClick={back}>
                  返回书库
                </button>
              </div>
            </div>
          ) : null}

          {!loading && !failure && frameSrc ? (
            <iframe ref={frameRef} className="rd-frame" src={frameSrc} title={title} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

const RD_CSS = `
.rd{--rd-panel:#fff;--rd-bar:rgba(255,255,255,.94);--rd-line:#ececec;--rd-text:#1a1a1a;--rd-sub:#848383;--rd-hover:#f2f2f2;--rd-active:#e8f8ef;--rd-stage:#fff;
  height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--rd-panel);color:var(--rd-text)}
.rd[data-theme='paper']{--rd-panel:#f8f3e8;--rd-bar:rgba(248,243,232,.94);--rd-line:#e6ddc9;--rd-text:#3a3226;--rd-sub:#8a7f6c;--rd-hover:#efe7d6;--rd-active:#e2f3e8;--rd-stage:#f6f0e2}
.rd[data-theme='dark']{--rd-panel:#1a1a1a;--rd-bar:rgba(26,26,26,.94);--rd-line:#2c2c2c;--rd-text:#e4e4e4;--rd-sub:#8b8b8b;--rd-hover:#2a2a2a;--rd-active:#123524;--rd-stage:#161616}
.rd *{box-sizing:border-box}
.rd-bar{flex:none;height:58px;display:flex;align-items:center;gap:8px;padding:0 20px 0 16px;border-bottom:1px solid var(--rd-line);background:var(--rd-bar)}
.rd-tool{width:32px;height:32px;display:grid;place-items:center;border-radius:8px;color:var(--rd-text);flex:none}
.rd-tool:hover:not(:disabled){background:var(--rd-hover)}
.rd-tool:disabled{opacity:.4;cursor:default}
.rd-tool.is-on{color:var(--accent);background:var(--rd-active)}
.rd .btn:not(.btn-primary){background:var(--rd-hover);color:var(--rd-text)}
.rd .btn:not(.btn-primary):hover:not(:disabled){background:var(--rd-line)}
.rd-meta{min-width:0;max-width:34%;display:flex;flex-direction:column;gap:2px;margin:0 8px 0 10px}
.rd-title{font-size:15px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rd-sub{font-size:12px;color:var(--rd-sub);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rd-spacer{flex:1}
.rd-group{display:flex;align-items:center;gap:6px;flex:none}
.rd-count{font-size:12px;color:var(--rd-sub);min-width:58px;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
.rd-fs-btn{font-size:13px;font-weight:600;letter-spacing:-.5px;display:inline-flex;align-items:flex-start;justify-content:center;padding-top:9px}
.rd-fs-btn small{font-size:10px;line-height:1;margin-left:1px;margin-top:1px}
.rd-fs{font-size:12px;color:var(--rd-sub);width:20px;text-align:center;font-variant-numeric:tabular-nums}
.rd-themes{display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:999px;background:var(--rd-hover);flex:none;margin-left:6px}
.rd-dot{width:20px;height:20px;border-radius:50%;border:1px solid rgba(0,0,0,.14)}
.rd-dot[data-t='light']{background: var(--surface)}
.rd-dot[data-t='paper']{background:#f2e8d2}
.rd-dot[data-t='dark']{background:#1d1d1d;border-color:rgba(255,255,255,.2)}
.rd-dot.is-on{box-shadow:0 0 0 2px var(--accent);border-color:transparent}
.rd-body{flex:1;min-height:0;display:flex}
.rd-toc{width:272px;flex:none;border-right:1px solid var(--rd-line);background:var(--rd-panel);overflow-y:auto;padding:12px 10px 40px}
.rd-toc-head{display:flex;align-items:center;justify-content:space-between;padding:2px 10px 10px;font-size:12px;color:var(--rd-sub);letter-spacing:.04em}
.rd-toc-item{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;padding:9px 12px;border-radius:8px;font-size:14px;line-height:1.5;color:var(--rd-sub)}
.rd-toc-item:hover{background:var(--rd-hover);color:var(--rd-text)}
.rd-toc-item.is-active{background:var(--rd-active);color:var(--accent);font-weight:600}
.rd-toc-num{font-size:11px;opacity:.72;min-width:18px;text-align:right;font-variant-numeric:tabular-nums;flex:none}
.rd-toc-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rd-stage{flex:1;min-width:0;display:flex;align-items:stretch;justify-content:center;background:var(--rd-stage);overflow:hidden}
.rd-frame{width:100%;height:100%;border:0;display:block;background:var(--rd-stage)}
.rd-empty{margin:auto;font-size:14px;color:var(--rd-sub)}
.rd-fail{margin:auto;max-width:480px;padding:0 24px;display:flex;flex-direction:column;align-items:flex-start;gap:12px}
.rd-fail-title{font-size:19px;font-weight:600}
.rd-fail-msg{margin:0;font-size:14px;line-height:1.7;color:var(--rd-sub)}
.rd-fail-actions{display:flex;gap:10px;margin-top:4px}
`
