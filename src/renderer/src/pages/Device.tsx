import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, KindleDevice, SendResult } from '../../../shared/types'
import { CH } from '../../../shared/ipc'
import { useApp } from '../app/context'
import { coverUrl, formatBytes } from '../lib/cover'
import { IconCheck, IconClose, IconDevice, IconMail, IconRefresh } from '../icons'

/**
 * 设备页：上半 Kindle USB 复制，下半邮件推送。
 * 选书列表做在本页右侧 —— 书库页的「推送 Kindle」跳过来时全局选中会被清空（App.navigate 的行为），
 * 所以这里自己维护勾选，推送按钮直接读这里的选择。
 */

/** 主进程 device.ts 返回的结构；shared/types 里没有对应类型，也不允许改 shared，这里本地声明 */
interface SendItem {
  id: number
  title: string
  ok: boolean
  message: string
}

interface SendResultWithItems {
  ok: boolean
  message: string
  items: SendItem[]
  targetPath?: string
}

interface RecentSend {
  at: number
  title: string
  ok: boolean
  message: string
}

const RECENT_KEY = 'eebookk.recentSends'

const CSS = `
.ds-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 392px;
  gap: 16px;
  align-items: start;
}
@media (max-width: 1180px) {
  .ds-grid { grid-template-columns: minmax(0, 1fr); }
}
.ds-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.ds-col > .panel + .panel { margin-top: 0; }
.ds-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ds-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
.ds-dot.is-off { background: #c9c9c9; box-shadow: 0 0 0 3px #f2f2f2; }
.ds-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--accent-weak);
  color: var(--accent-press);
  flex: none;
}
.ds-badge.is-off { background: #f2f2f2; color: var(--t2); }
.ds-meter { height: 6px; border-radius: 3px; background: #ededed; overflow: hidden; margin: 12px 0 6px; }
.ds-meter > i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.ds-rows { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.ds-kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: var(--t2);
}
.ds-kv > span:last-child {
  min-width: 0;
  color: var(--t1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-path { font-family: Consolas, 'Courier New', monospace; font-size: 12px; color: var(--t3); }
.ds-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.ds-actions .ds-note { flex-basis: 100%; }
.ds-note { font-size: 12px; color: var(--t2); line-height: 1.6; margin: 0; }
.ds-note.is-warn { color: #b56a00; }
.ds-hint-list { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: var(--t2); line-height: 1.9; }
.ds-list {
  margin-top: 10px;
  max-height: 452px;
  overflow-y: auto;
  border: 1px solid var(--hairline-soft);
  border-radius: 10px;
}
.ds-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--hairline-soft);
  cursor: pointer;
  user-select: none;
}
.ds-item:last-child { border-bottom: 0; }
.ds-item:hover { background: var(--surface-2); }
.ds-item.is-on { background: var(--accent-weak); }
.ds-check {
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 4px;
  border: 1.5px solid #d2d2d2;
  background: #fff;
  display: grid;
  place-items: center;
  color: #fff;
}
.ds-item.is-on .ds-check { background: var(--accent); border-color: var(--accent); }
.ds-cover {
  width: 28px;
  height: 38px;
  flex: none;
  display: block;
  border-radius: 3px;
  object-fit: cover;
  background: #f0f0f0;
}
.ds-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ds-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-sub { font-size: 11.5px; color: var(--t2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-tag { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 9px; background: #f2f2f2; color: var(--t2); }
.ds-tag.is-warn { background: #fff4e5; color: #b56a00; }
.ds-search { flex: 1; min-width: 0; }
.ds-check-label { display: flex; align-items: center; gap: 5px; font-size: 13px; color: var(--t3); white-space: nowrap; cursor: pointer; }
.ds-empty { padding: 26px 0; text-align: center; font-size: 13px; color: #a8a8a8; }
.ds-fails {
  margin-top: 12px;
  padding: 2px 0 2px 10px;
  border-left: 3px solid var(--badge);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ds-fail { font-size: 12px; color: #c0392b; line-height: 1.5; }
.ds-records { margin-top: 16px; }
.ds-record { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; border-top: 1px solid var(--hairline-soft); font-size: 12.5px; }
.ds-record-time { flex: none; color: var(--t2); font-variant-numeric: tabular-nums; }
.ds-record-main { min-width: 0; flex: 1; }
.ds-record-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-record-msg { color: var(--t2); font-size: 11.5px; line-height: 1.5; margin-top: 2px; }
.ds-ok { color: var(--accent); flex: none; }
.ds-bad { color: var(--badge); flex: none; }
`

function loadRecent(): RecentSend[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as RecentSend[]
    return Array.isArray(list) ? list.slice(0, 10) : []
  } catch {
    return []
  }
}

function saveRecent(list: RecentSend[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)))
  } catch {
    /* 隐私模式写不进去也不影响用 */
  }
}

function formatTime(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`
}

export default function Device(): React.ReactElement {
  const { books, selected, setSelected, toggleSelected, clearSelection, toast, invoke, navigate } = useApp()
  const [devices, setDevices] = useState<KindleDevice[]>([])
  const [detecting, setDetecting] = useState(true)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [busy, setBusy] = useState<'usb' | 'email' | 'test' | null>(null)
  const [keyword, setKeyword] = useState('')
  const [onlyEpub, setOnlyEpub] = useState(false)
  const [recent, setRecent] = useState<RecentSend[]>(loadRecent)
  const [lastItems, setLastItems] = useState<SendItem[]>([])

  // 挂载时检测设备 + 读设置；这里直接用 window.api，避免 useApp().invoke 的引用变化把 effect 反复触发
  useEffect(() => {
    let alive = true
    window.api
      .invoke<KindleDevice[]>(CH.deviceDetect)
      .then((list) => {
        if (alive) setDevices(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (alive) setDevices([])
      })
      .finally(() => {
        if (alive) setDetecting(false)
      })
    window.api
      .invoke<AppSettings | undefined>(CH.settingsGet)
      .then((next) => {
        if (alive && next) setSettings(next)
      })
      .catch(() => {
        /* 设置读不到就按「未配置」显示 */
      })
    return () => {
      alive = false
    }
  }, [])

  const refresh = async (): Promise<void> => {
    setDetecting(true)
    try {
      // 传 true 跳过主进程 8 秒缓存，用户点「重新检测」时必须是真扫
      const list = await window.api.invoke<KindleDevice[]>(CH.deviceDetect, true)
      setDevices(Array.isArray(list) ? list : [])
    } catch (e) {
      toast(`检测设备失败：${String(e)}`, 'error')
    } finally {
      setDetecting(false)
    }
  }

  const kindle = devices[0] ?? null
  const smtp = settings?.smtp
  const smtpReady = Boolean(
    smtp?.enabled && smtp.host && smtp.user && smtp.hasPassword && smtp.kindleEmail
  )

  const selectedBooks = useMemo(() => books.filter((b) => selected.includes(b.id)), [books, selected])
  const noEpubCount = selectedBooks.filter((b) => !b.formats.includes('EPUB')).length

  const candidates = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    let list = books
    if (onlyEpub) list = list.filter((b) => b.formats.includes('EPUB'))
    if (kw) {
      list = list.filter(
        (b) => b.title.toLowerCase().includes(kw) || (b.authors ?? '').toLowerCase().includes(kw)
      )
    }
    return list
  }, [books, keyword, onlyEpub])
  const visible = candidates.slice(0, 200)
  const epubInView = visible.filter((b) => b.formats.includes('EPUB'))

  const pushRecent = (res: SendResultWithItems): void => {
    const titles = (res.items ?? []).filter((item) => item.ok).map((item) => item.title)
    const title = titles.length
      ? titles.length > 3
        ? `${titles.slice(0, 3).join('、')} 等 ${titles.length} 本`
        : titles.join('、')
      : '未推送成功'
    const entry: RecentSend = { at: Date.now(), title, ok: res.ok, message: res.message }
    setRecent((prev) => {
      const next = [entry, ...prev].slice(0, 10)
      saveRecent(next)
      return next
    })
  }

  const runSend = async (mode: 'usb' | 'email'): Promise<void> => {
    if (!selected.length || busy) return
    setBusy(mode)
    try {
      const res = await invoke<SendResultWithItems>(CH.deviceSend, {
        bookIds: selected,
        mode,
        mountPath: kindle?.mountPath
      })
      setLastItems(Array.isArray(res.items) ? res.items : [])
      pushRecent(res)
      toast(res.message, res.ok ? 'success' : 'error')
      if (mode === 'usb' && res.ok) void refresh()
    } catch (e) {
      toast(`推送失败：${String(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const runTest = async (): Promise<void> => {
    if (busy) return
    setBusy('test')
    try {
      const res = await invoke<SendResult>(CH.smtpTest)
      toast(res.message, res.ok ? 'success' : 'error')
    } catch (e) {
      toast(`测试失败：${String(e)}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const failures = lastItems.filter((item) => !item.ok)
  const usedPercent =
    kindle && kindle.totalBytes > 0
      ? Math.min(100, Math.round(((kindle.totalBytes - kindle.freeBytes) / kindle.totalBytes) * 100))
      : 0

  return (
    <div className="page">
      <style>{CSS}</style>

      <div className="page-head">
        <h1 className="page-title">设备</h1>
        <span className="page-sub">
          {detecting
            ? '正在检测 Kindle…'
            : kindle
              ? `已连接 ${kindle.label}`
              : '未检测到 Kindle'}
          {selected.length > 0 ? ` · 已选 ${selected.length} 本` : ''}
        </span>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" disabled={detecting} onClick={() => void refresh()}>
          <IconRefresh width={16} height={16} />
          重新检测
        </button>
      </div>

      <div className="ds-grid">
        <div className="ds-col">
          {/* ---------- Kindle USB ---------- */}
          <div className="panel">
            <div className="ds-row">
              <span className={`ds-dot${kindle ? '' : ' is-off'}`} />
              <span className="panel-title" style={{ margin: 0 }}>
                Kindle USB
              </span>
              <span className="spacer" />
              <span className={`ds-badge${kindle ? '' : ' is-off'}`}>
                {kindle ? '已连接' : '未连接'}
              </span>
            </div>

            {kindle ? (
              <>
                <p className="panel-hint" style={{ margin: '6px 0 0' }}>
                  {kindle.label} · 盘符 {kindle.mountPath}
                </p>
                <div className="ds-meter">
                  <i style={{ width: `${usedPercent}%` }} />
                </div>
                <div className="ds-kv">
                  <span>剩余 {formatBytes(kindle.freeBytes)}</span>
                  <span>共 {formatBytes(kindle.totalBytes)}</span>
                </div>
                <div className="ds-rows">
                  <div className="ds-kv">
                    <span>documents 里已有</span>
                    <span>{kindle.documentCount} 个文件</span>
                  </div>
                  <div className="ds-kv">
                    <span>推送目录</span>
                    <span className="ds-path" title={`${kindle.mountPath}documents\\eebookk\\`}>
                      {`${kindle.mountPath}documents\\eebookk\\`}
                    </span>
                  </div>
                </div>
                <div className="ds-actions">
                  <button
                    className="btn btn-primary"
                    disabled={selected.length === 0 || busy !== null}
                    onClick={() => void runSend('usb')}
                  >
                    <IconDevice width={16} height={16} />
                    {busy === 'usb'
                      ? '正在复制…'
                      : selected.length > 0
                        ? `推送到 Kindle（${selected.length} 本）`
                        : '先选书'}
                  </button>
                  <span className="ds-note">
                    复制不影响书库；安全弹出后在设备上刷新书库即可看到。
                  </span>
                </div>
              </>
            ) : (
              <>

                <div className="ds-actions">
                  <button className="btn" disabled={detecting} onClick={() => void refresh()}>
                    <IconRefresh width={16} height={16} />
                    {detecting ? '检测中…' : '重新检测'}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ---------- 邮件推送 ---------- */}
          <div className="panel">
            <div className="ds-row">
              <IconMail width={18} height={18} />
              <span className="panel-title" style={{ margin: 0 }}>
                邮件推送
              </span>
              <span className="spacer" />
              <span className={`ds-badge${smtpReady ? '' : ' is-off'}`}>
                {smtpReady ? '已配置' : '未配置'}
              </span>
            </div>

            <div className="ds-rows">
              <div className="ds-kv">
                <span>SMTP 服务器</span>
                <span>
                  {smtp?.host
                    ? `${smtp.host}:${smtp.port} · ${smtp.secure ? 'SSL' : 'STARTTLS'}`
                    : '未填写'}
                </span>
              </div>
              <div className="ds-kv">
                <span>授权码</span>
                <span>{smtp?.hasPassword ? '已保存（safeStorage 加密）' : '未保存'}</span>
              </div>
              <div className="ds-kv">
                <span>发件账号</span>
                <span>{smtp?.user || '未填写'}</span>
              </div>
              <div className="ds-kv">
                <span>Kindle 邮箱</span>
                <span>{smtp?.kindleEmail || '未填写'}</span>
              </div>
            </div>

            {!smtpReady ? (
              <p className="ds-note is-warn" style={{ marginTop: 10 }}>
                邮件推送需要先在「设置」里填好 SMTP 服务器、账号、授权码和 Kindle 邮箱。
              </p>
            ) : null}

            <div className="ds-actions">
              <button
                className="btn btn-primary"
                disabled={selected.length === 0 || busy !== null}
                onClick={() => void runSend('email')}
              >
                <IconMail width={16} height={16} />
                {busy === 'email'
                  ? '正在发送…'
                  : selected.length > 0
                    ? `发送到 Kindle 邮箱（${selected.length} 本）`
                    : '先选书'}
              </button>
              <button className="btn" disabled={busy !== null} onClick={() => void runTest()}>
                {busy === 'test' ? '测试中…' : '发送测试邮件'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'settings' })}>
                去设置
              </button>
              <span className="ds-note">
                测试邮件发到发件账号自己；Amazon 单封上限 25 MB，2022 年起只收 EPUB / PDF / DOCX。
              </span>
            </div>

            {failures.length > 0 ? (
              <div className="ds-fails">
                {failures.slice(0, 6).map((item) => (
                  <div key={item.id} className="ds-fail">
                    《{item.title}》{item.message}
                  </div>
                ))}
                {failures.length > 6 ? (
                  <div className="ds-fail">…还有 {failures.length - 6} 条</div>
                ) : null}
              </div>
            ) : null}

            <div className="ds-records">
              <div className="ds-row">
                <span className="panel-title" style={{ margin: 0, fontSize: 14 }}>
                  最近推送
                </span>
                <span className="spacer" />
                {recent.length > 0 ? (
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setRecent([])
                      saveRecent([])
                    }}
                  >
                    清空
                  </button>
                ) : null}
              </div>
              {recent.length === 0 ? (
                <div className="ds-empty">还没有推送记录</div>
              ) : (
                recent.map((item) => (
                  <div className="ds-record" key={`${item.at}-${item.title}`}>
                    {item.ok ? (
                      <span className="ds-ok">
                        <IconCheck width={14} height={14} />
                      </span>
                    ) : (
                      <span className="ds-bad">
                        <IconClose width={14} height={14} />
                      </span>
                    )}
                    <span className="ds-record-time">{formatTime(item.at)}</span>
                    <span className="ds-record-main">
                      <span className="ds-record-title">{item.title}</span>
                      <span className="ds-record-msg">{item.message}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* ---------- 选书 ---------- */}
        <div className="panel">
          <div className="ds-row">
            <span className="panel-title" style={{ margin: 0 }}>
              选择要推送的书
            </span>
            <span className="spacer" />
            <span className="ds-note">已选 {selected.length} 本</span>
          </div>


          <div className="ds-row">
            <input
              className="input ds-search"
              placeholder="搜索书名 / 作者"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <label className="ds-check-label">
              <input type="checkbox" checked={onlyEpub} onChange={(e) => setOnlyEpub(e.target.checked)} />
              只看 EPUB
            </label>
          </div>

          <div className="ds-list">
            {visible.length === 0 ? (
              <div className="ds-empty">没有符合条件的书</div>
            ) : (
              visible.map((book) => {
                const isOn = selected.includes(book.id)
                const hasEpub = book.formats.includes('EPUB')
                return (
                  <div
                    key={book.id}
                    className={`ds-item${isOn ? ' is-on' : ''}`}
                    onClick={() => toggleSelected(book.id)}
                    title={`${book.title}\n${book.authors || '佚名'}`}
                  >
                    <span className="ds-check">{isOn ? <IconCheck width={12} height={12} /> : null}</span>
                    {book.hasCover ? (
                      <img
                        className="ds-cover"
                        src={coverUrl(book.id)}
                        alt=""
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <span className="ds-cover" />
                    )}
                    <span className="ds-main">
                      <span className="ds-title">{book.title}</span>
                      <span className="ds-sub">
                        {book.authors || '佚名'} · {formatBytes(book.sizeBytes)}
                      </span>
                    </span>
                    {hasEpub ? (
                      <span className="ds-tag">EPUB</span>
                    ) : (
                      <span className="ds-tag is-warn">无 EPUB</span>
                    )}
                  </div>
                )
              })
            )}
            {candidates.length > visible.length ? (
              <div className="ds-empty">
                还有 {candidates.length - visible.length} 本，用搜索缩小范围
              </div>
            ) : null}
          </div>

          {noEpubCount > 0 ? (
            <p className="ds-note is-warn" style={{ marginTop: 8 }}>
              已选里有 {noEpubCount} 本没有 EPUB，推送会失败 —— 先到「转换」页转成 EPUB。
            </p>
          ) : null}

          <div className="ds-actions">
            <button
              className="btn btn-sm btn-ghost"
              disabled={epubInView.length === 0}
              onClick={() => setSelected(epubInView.map((b) => b.id))}
            >
              全选当前 EPUB
            </button>
            <button className="btn btn-sm btn-ghost" disabled={selected.length === 0} onClick={clearSelection}>
              清空
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
