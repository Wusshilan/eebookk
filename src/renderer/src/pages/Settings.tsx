import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, BookSource, UpdateInfo } from '../../../shared/types'
import { CH } from '../../../shared/ipc'
import { useApp } from '../app/context'
import { applyAppearance } from '../lib/appearance'
import { IconCheck, IconRefresh } from '../icons'

type TabKey = 'general' | 'library' | 'convert' | 'device' | 'sources' | 'web' | 'update' | 'about'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'library', label: '书库' },
  { key: 'convert', label: '转换与元数据' },
  { key: 'device', label: '设备与推送' },
  { key: 'sources', label: '书源' },
  { key: 'web', label: '全网检索' },
  { key: 'update', label: '更新' },
  { key: 'about', label: '关于' }
]

const TARGETS = ['epub', 'mobi', 'azw3', 'pdf', 'txt']

const PRESETS: { name: string; host: string; port: number; secure: boolean }[] = [
  { name: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: true },
  { name: '163 邮箱', host: 'smtp.163.com', port: 465, secure: true },
  { name: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false },
  { name: 'Outlook', host: 'smtp.office365.com', port: 587, secure: false }
]



/** 一行设置：左边标题，右边控件 */
function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>{label}</span>
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Check({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}): React.ReactElement {
  return (
    <label className="set-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export default function Settings(): React.ReactElement {
  const { payload, invoke, toast, reload, calibreRunning, ask } = useApp()
  const [tab, setTab] = useState<TabKey>('general')
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let alive = true
    window.api
      .invoke<AppSettings | null>(CH.settingsGet)
      .then((s) => {
        if (!alive) return
        if (!s) {
          setLoadError('没读到设置，先用默认值')
          return
        }
        setDraft(s)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(`读取设置失败：${String(e)}`)
      })
    window.api
      .invoke<UpdateInfo>(CH.updateCheck)
      .then((info) => alive && setUpdateInfo(info))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const version = updateInfo?.current ?? ''
  const chrome = useMemo(() => navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '—', [])

  const patch = <K extends keyof AppSettings>(key: K, value: Partial<AppSettings[K]>): void => {
    setDraft((prev) => (prev ? { ...prev, [key]: { ...(prev[key] as object), ...value } } : prev))
  }

  const updateSource = (id: string, next: Partial<BookSource>): void => {
    setDraft((prev) =>
      prev
        ? { ...prev, sources: prev.sources.map((s) => (s.id === id ? { ...s, ...next } : s)) }
        : prev
    )
  }

  const removeSource = (id: string): void => {
    setDraft((prev) => (prev ? { ...prev, sources: prev.sources.filter((s) => s.id !== id) } : prev))
  }

  const addSource = async (): Promise<void> => {
    const name = await ask({
      title: '添加书目源',
      message: '目前只认 OPDS（Atom 目录）。calibre 用的也是这套，多数公共图书馆都提供。',
      label: '名称',
      placeholder: '例如：古登堡',
      okText: '下一步'
    })
    if (!name?.trim()) return
    const url = await ask({
      title: '书目源地址',
      message: '填目录根地址，形如 https://example.org/opds',
      label: 'OPDS 地址',
      placeholder: 'https://example.org/opds',
      okText: '添加'
    })
    if (!url?.trim()) return
    const id = `custom-${Date.now().toString(36)}`
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            sources: [
              ...prev.sources,
              {
                id,
                name: name.trim(),
                kind: 'opds',
                url: url.trim(),
                searchUrl: '',
                enabled: true
              }
            ]
          }
        : prev
    )
    toast('已添加，记得保存')
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        convert: draft.convert,
        appearance: draft.appearance,
        update: draft.update,
        general: draft.general,
        metadata: draft.metadata,
        device: draft.device,
        sources: draft.sources,
        web: draft.web,
        smtp: {
          enabled: draft.smtp.enabled,
          host: draft.smtp.host.trim(),
          port: Number(draft.smtp.port) || 465,
          secure: draft.smtp.secure,
          user: draft.smtp.user.trim(),
          from: draft.smtp.from.trim(),
          kindleEmail: draft.smtp.kindleEmail.trim()
        }
      }
      if (password.trim()) body.smtpPassword = password.trim()
      const next = await invoke<AppSettings | null>(CH.settingsSet, body)
      if (next) {
        setDraft(next)
        applyAppearance(next.appearance)
      }
      setPassword('')
      toast('已保存')
    } catch (e) {
      toast(`保存失败：${String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const testMail = async (): Promise<void> => {
    setTesting(true)
    try {
      await save()
      const res = await invoke<{ ok: boolean; message: string }>(CH.smtpTest)
      toast(res.message || (res.ok ? '测试邮件已发出' : '发送失败'), res.ok ? 'success' : 'error')
    } catch (e) {
      toast(String(e), 'error')
    } finally {
      setTesting(false)
    }
  }

  const checkNow = async (): Promise<void> => {
    setChecking(true)
    try {
      const info = await invoke<UpdateInfo>(CH.updateCheck, true)
      setUpdateInfo(info)
      toast(
        info.hasUpdate
          ? `有新版 ${info.latest}`
          : info.message
            ? `${info.message}（当前 ${info.current}）`
            : `已是最新 ${info.current}`
      )
    } finally {
      setChecking(false)
    }
  }

  const backup = async (): Promise<void> => {
    const res = await invoke<{ ok: boolean; message: string }>(CH.libraryBackup)
    toast(res.message, res.ok ? 'success' : 'error')
  }

  const openCalibre = async (): Promise<void> => {
    const res = await invoke<{ ok: boolean; message: string }>(CH.openCalibre)
    if (!res.ok) toast(res.message, 'error')
  }

  const pickDir = async (): Promise<void> => {
    const res = await invoke<{ ok: boolean; path?: string }>(CH.pickDirectory)
    if (res.ok && res.path) patch('convert', { outputDir: res.path })
  }

  if (!draft) {
    return (
      <div className="page">
        <div className="empty">
          正在读取设置
          {loadError ? <div style={{ marginTop: 8, color: 'var(--badge)' }}>{loadError}</div> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="page settings-page">
      <div className="set-head">
        <h1 className="set-title">设置</h1>
        <span className="spacer" />
        <button className="btn" disabled={saving} onClick={() => void checkNow()}>
          {checking ? '检查中' : '检查更新'}
        </button>
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中' : '保存'}
        </button>
      </div>

      <nav className="set-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`set-tab${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="set-body">
        {tab === 'general' ? (
          <>
            <section className="set-section">
              <h2 className="set-h2">启动</h2>
              <Row label="恢复上次页面">
                <Check
                  checked={draft.general.restoreLastPage}
                  onChange={(v) => patch('general', { restoreLastPage: v })}
                  label="开启"
                />
              </Row>
              <Row label="搜索快捷键">
                <span className="set-ro">
                  <kbd className="set-kbd">Ctrl</kbd> + <kbd className="set-kbd">K</kbd>
                </span>
              </Row>
              <Row label="界面语言">
                <span className="set-ro">简体中文</span>
              </Row>
            </section>

            <section className="set-section">
              <h2 className="set-h2">外观</h2>
              <Row label="封面圆角">
                <div className="set-inline">
                  <input
                    type="range"
                    min={0}
                    max={16}
                    value={draft.appearance.coverRadius}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      patch('appearance', { coverRadius: v })
                      applyAppearance({ ...draft.appearance, coverRadius: v })
                    }}
                  />
                  <span className="set-ro set-num">{draft.appearance.coverRadius}px</span>
                </div>
              </Row>
              <Row label="网格密度">
                <div className="seg">
                  <button
                    className={`seg-item${draft.appearance.gridDensity === 'comfortable' ? ' is-active' : ''}`}
                    onClick={() => {
                      patch('appearance', { gridDensity: 'comfortable' })
                      applyAppearance({ ...draft.appearance, gridDensity: 'comfortable' })
                    }}
                  >
                    舒适
                  </button>
                  <button
                    className={`seg-item${draft.appearance.gridDensity === 'compact' ? ' is-active' : ''}`}
                    onClick={() => {
                      patch('appearance', { gridDensity: 'compact' })
                      applyAppearance({ ...draft.appearance, gridDensity: 'compact' })
                    }}
                  >
                    紧凑
                  </button>
                </div>
              </Row>
              <Row label="主题">
                <span className="set-ro">浅色</span>
              </Row>
            </section>
          </>
        ) : null}

        {tab === 'library' ? (
          <section className="set-section">
            <h2 className="set-h2">书库</h2>
            <Row label="路径">
              <span className="set-path" title={payload.path}>
                {payload.path || '没找到书库'}
              </span>
            </Row>
            <Row label="收录">
              <div className="set-stats">
                <span><b>{payload.stats.total}</b> 本</span>
                <span><b>{payload.stats.tags}</b> 标签</span>
                <span><b>{payload.stats.authors}</b> 作者</span>
                <span><b>{payload.stats.series}</b> 系列</span>
                <span><b>{payload.stats.publishers}</b> 出版社</span>
              </div>
            </Row>
            <Row label="重新读取">
              <button className="btn btn-sm" onClick={() => void reload()}>
                <IconRefresh width={14} height={14} />
                重新读取
              </button>
            </Row>
            <Row label="备份 metadata.db">
              <button className="btn btn-sm" onClick={() => void backup()}>
                立即备份
              </button>
            </Row>
            <Row label="calibre">
              <div className="set-inline">
                <button className="btn btn-sm" onClick={() => void openCalibre()}>
                  打开 calibre
                </button>
                <span className={`set-ro${calibreRunning ? '' : ''}`}>
                  {calibreRunning ? '运行中' : '未运行'}
                </span>
              </div>
            </Row>
          </section>
        ) : null}

        {tab === 'convert' ? (
          <>
            <section className="set-section">
              <h2 className="set-h2">转换</h2>
              <Row label="默认目标格式">
                <select
                  className="select"
                  value={draft.convert.defaultTarget}
                  onChange={(e) => patch('convert', { defaultTarget: e.target.value })}
                >
                  {TARGETS.map((t) => (
                    <option key={t} value={t}>{t.toUpperCase()}</option>
                  ))}
                </select>
              </Row>
              <Row label="同时转换几本">
                <select
                  className="select"
                  value={draft.convert.concurrency}
                  onChange={(e) => patch('convert', { concurrency: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </Row>
              <Row label="输出目录">
                <div className="set-inline">
                  <input
                    className="input"
                    value={draft.convert.outputDir}
                    placeholder="默认位置"
                    onChange={(e) => patch('convert', { outputDir: e.target.value })}
                  />
                  <button className="btn btn-sm" onClick={() => void pickDir()}>选择</button>
                  <button
                    className="btn btn-sm"
                    disabled={!draft.convert.outputDir}
                    onClick={() => patch('convert', { outputDir: '' })}
                  >
                    清空
                  </button>
                </div>
              </Row>
              <Row label="附加参数">
                <input
                  className="input"
                  value={draft.convert.extraArgs}
                  placeholder="例如 --base-font-size 18"
                  onChange={(e) => patch('convert', { extraArgs: e.target.value })}
                />
              </Row>
            </section>

            <section className="set-section">
              <h2 className="set-h2">元数据</h2>
              <Row label="作者分隔符">
                <input
                  className="input set-narrow"
                  value={draft.metadata.authorSeparator}
                  onChange={(e) => patch('metadata', { authorSeparator: e.target.value })}
                />
              </Row>
              <Row label="标签分隔符">
                <input
                  className="input set-narrow"
                  value={draft.metadata.tagSeparator}
                  onChange={(e) => patch('metadata', { tagSeparator: e.target.value })}
                />
              </Row>
              <Row label="保存后嵌入文件">
                <Check
                  checked={draft.metadata.embedOnSave}
                  onChange={(v) => patch('metadata', { embedOnSave: v })}
                  label="开启"
                />
              </Row>
            </section>
          </>
        ) : null}

        {tab === 'device' ? (
          <>
            <section className="set-section">
              <h2 className="set-h2">邮件推送</h2>
              <Row label="启用">
                <Check
                  checked={draft.smtp.enabled}
                  onChange={(v) => patch('smtp', { enabled: v })}
                  label="开启邮件推送"
                />
              </Row>
              <Row label="快速填写">
                <div className="set-inline">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      className="btn btn-sm"
                      onClick={() => patch('smtp', { host: p.host, port: p.port, secure: p.secure })}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="服务器">
                <input
                  className="input"
                  value={draft.smtp.host}
                  onChange={(e) => patch('smtp', { host: e.target.value })}
                />
              </Row>
              <Row label="端口">
                <div className="set-inline">
                  <input
                    className="input set-port"
                    value={draft.smtp.port}
                    onChange={(e) => patch('smtp', { port: Number(e.target.value) || 465 })}
                  />
                  <Check
                    checked={draft.smtp.secure}
                    onChange={(v) => patch('smtp', { secure: v })}
                    label="SSL / TLS"
                  />
                </div>
              </Row>
              <Row label="账号">
                <input
                  className="input"
                  value={draft.smtp.user}
                  placeholder="you@qq.com"
                  onChange={(e) => patch('smtp', { user: e.target.value })}
                />
              </Row>
              <Row label="授权码">
                <div className="set-inline">
                  <input
                    className="input"
                    type="password"
                    value={password}
                    placeholder={draft.smtp.hasPassword ? '已保存，留空就不改' : '授权码'}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {draft.smtp.hasPassword ? (
                    <span className="set-ok">
                      <IconCheck width={13} height={13} />
                      已存
                    </span>
                  ) : null}
                </div>
              </Row>
              <Row label="发件人">
                <input
                  className="input"
                  value={draft.smtp.from}
                  placeholder="you@qq.com"
                  onChange={(e) => patch('smtp', { from: e.target.value })}
                />
              </Row>
              <Row label="Kindle 邮箱">
                <input
                  className="input"
                  value={draft.smtp.kindleEmail}
                  placeholder="xxx@kindle.com"
                  onChange={(e) => patch('smtp', { kindleEmail: e.target.value })}
                />
              </Row>
              <Row label="发封测试邮件">
                <button className="btn btn-sm" disabled={testing || saving} onClick={() => void testMail()}>
                  {testing ? '发送中' : '保存并发测试'}
                </button>
              </Row>
            </section>

            <section className="set-section">
              <h2 className="set-h2">USB 推送</h2>
              <Row label="Kindle 子目录">
                <input
                  className="input set-narrow"
                  value={draft.device.usbSubdir}
                  onChange={(e) => patch('device', { usbSubdir: e.target.value })}
                />
              </Row>
              <Row label="单封上限">
                <div className="set-inline">
                  <input
                    className="input set-port"
                    value={draft.device.maxAttachmentMB}
                    onChange={(e) => patch('device', { maxAttachmentMB: Number(e.target.value) || 25 })}
                  />
                  <span className="set-unit">MB</span>
                </div>
              </Row>
            </section>
          </>
        ) : null}

        {tab === 'update' ? (
          <section className="set-section">
            <h2 className="set-h2">更新</h2>
            <Row label="版本清单地址">
              <input
                className="input"
                value={draft.update.endpoint}
                placeholder="https://example.com/eebookk/latest.json"
                onChange={(e) => patch('update', { endpoint: e.target.value })}
              />
            </Row>
            <Row label="启动时检查">
              <Check
                checked={draft.update.autoCheck}
                onChange={(v) => patch('update', { autoCheck: v })}
                label="开启"
              />
            </Row>
            <Row label="当前">
              <div className="set-inline">
                <span className="set-ro">
                  {updateInfo?.hasUpdate
                    ? `有新版 ${updateInfo.latest}`
                    : `v${version || '—'}`}
                  {updateInfo?.message && !updateInfo.hasUpdate ? `（${updateInfo.message}）` : ''}
                </span>
                <button className="btn btn-sm" disabled={checking} onClick={() => void checkNow()}>
                  {checking ? '检查中' : '立即检查'}
                </button>
              </div>
            </Row>
          </section>
        ) : null}

        {tab === 'sources' ? (
          <section className="set-section">
            <h2 className="set-h2">书目源</h2>

            {draft.sources.map((s) => (
              <Row key={s.id} label={s.name}>
                <div className="set-inline">
                  <Check
                    checked={s.enabled}
                    onChange={(v) => updateSource(s.id, { enabled: v })}
                    label="启用"
                  />
                  <input
                    className="input"
                    value={s.url}
                    placeholder="https://example.org/opds"
                    onChange={(e) => updateSource(s.id, { url: e.target.value })}
                  />
                  {s.builtin ? null : (
                    <button className="btn btn-sm" onClick={() => removeSource(s.id)}>
                      删除
                    </button>
                  )}
                </div>
              </Row>
            ))}
            <Row label="添加">
              <button className="btn btn-sm" onClick={() => void addSource()}>
                添加 OPDS 源
              </button>
            </Row>
          </section>
        ) : null}

        {tab === 'web' ? (
          <section className="set-section">
            <h2 className="set-h2">检索来源</h2>
            {[
              { id: 'douban', name: '豆瓣读书' },
              { id: 'weread', name: '微信读书' },
              { id: 'neodb', name: 'NeoDB' }
            ].map((s) => (
              <Row key={s.id} label={s.name}>
                <Check
                  checked={draft.web.sources.includes(s.id)}
                  onChange={(v) =>
                    patch('web', {
                      sources: v
                        ? [...draft.web.sources, s.id]
                        : draft.web.sources.filter((x) => x !== s.id)
                    })
                  }
                  label="启用"
                />
              </Row>
            ))}
            <Row label="封面最小宽度">
              <div className="set-inline">
                <input
                  className="input set-port"
                  value={draft.web.minCoverWidth}
                  onChange={(e) => patch('web', { minCoverWidth: Number(e.target.value) || 0 })}
                />
                <span className="set-unit">px</span>
              </div>
            </Row>
          </section>
        ) : null}

        {tab === 'about' ? (
          <section className="set-section">
            <h2 className="set-h2">关于</h2>
            <Row label="版本">
              <span className="set-ro">eebookk {version || '—'}</span>
            </Row>
            <Row label="引擎">
              <span className="set-ro">calibre</span>
            </Row>
            <Row label="运行时">
              <span className="set-ro">Electron · Chromium {chrome}</span>
            </Row>
            <Row label="许可">
              <span className="set-ro">MIT</span>
            </Row>
            <Row label="日志">
              <span className="set-path">%APPDATA%\eebookk\logs\app.log</span>
            </Row>
            <Row label="书库">
              <span className="set-path" title={payload.path}>{payload.path}</span>
            </Row>

          </section>
        ) : null}
      </div>
    </div>
  )
}
