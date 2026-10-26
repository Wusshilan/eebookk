import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings, BookSource, ShortcutSettings, TrashEntry, UpdateInfo
} from '../../../shared/types'
import { SHORTCUT_LABELS, comboOf } from '../lib/shortcuts'
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
  const [trash, setTrash] = useState<TrashEntry[]>([])
  /** 正在录制哪一个快捷键 */
  const [recording, setRecording] = useState<keyof ShortcutSettings | null>(null)

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
      .invoke<TrashEntry[]>(CH.trashList)
      .then((list) => alive && setTrash(Array.isArray(list) ? list : []))
      .catch(() => undefined)
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

  // 录制快捷键：按下的组合直接写进去
  useEffect(() => {
    if (!recording || !draft) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return
      const combo = comboOf(e)
      if (!/^(Ctrl|Alt)\b/.test(combo)) return
      setDraft((prev) =>
        prev ? { ...prev, shortcuts: { ...prev.shortcuts, [recording]: combo } } : prev
      )
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, draft])

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
      okText: '下一步'
    })
    if (!name?.trim()) return
    const url = await ask({
      title: 'OPDS 地址',
      okText: '下一步'
    })
    if (!url?.trim()) return
    const search = await ask({
      title: '搜索地址模板',
      label: '用 {q} 代表关键词',
      okText: '添加'
    })
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
                searchUrl: (search ?? '').trim(),
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
        library: draft.library,
        shortcuts: draft.shortcuts,
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

  const restoreTrash = async (): Promise<void> => {
    const res = await invoke<{ ok: boolean; message: string }>(CH.trashRestore, trash.map((t) => t.path))
    toast(res.message, res.ok ? 'success' : 'error')
    if (res.ok) {
      const list = await invoke<TrashEntry[]>(CH.trashList)
      setTrash(Array.isArray(list) ? list : [])
      await reload()
    }
  }

  const clearTrash = async (): Promise<void> => {
    const res = await invoke<{ ok: boolean; message: string }>(CH.trashClear)
    toast(res.message, res.ok ? 'success' : 'error')
    if (res.ok) setTrash([])
  }

  const openCalibre = async (): Promise<void> => {
    const res = await invoke<{ ok: boolean; message: string }>(CH.openCalibre)
    if (!res.ok) toast(res.message, 'error')
  }

  const pickDir = async (): Promise<void> => {
    const res = await invoke<{ ok: boolean; path?: string }>(CH.pickDirectory)
    if (res.ok && res.path) patch('convert', { outputDir: res.path })
  }

  /** 换书库：选一个含 metadata.db 的目录，主进程会重新打开并重读书库 */
  const pickLibrary = async (): Promise<void> => {
    const res = await invoke<{ ok: boolean; path?: string }>(CH.pickDirectory)
    if (!res.ok || !res.path) return
    await invoke(CH.settingsSet, { libraryPath: res.path })
    await reload()
    toast('书库已切换')
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
              <Row label="快捷键">
              <div className="sc-list">
                {SHORTCUT_LABELS.map((s) => (
                  <div className="sc-row" key={s.key}>
                    <span className="sc-name">{s.label}</span>
                    <button
                      className={`sc-key${recording === s.key ? ' is-rec' : ''}`}
                      onClick={() => setRecording(recording === s.key ? null : s.key)}
                    >
                      {recording === s.key ? '按下组合键…' : draft.shortcuts[s.key] || '未设置'}
                    </button>
                  </div>
                ))}
              </div>
            </Row>
            <Row label="界面语言">
                <span className="set-ro">简体中文</span>
              </Row>
            </section>

            <section className="set-section">
              <h2 className="set-h2">外观</h2>
              <Row label="主题">
                <div className="seg">
                  {[
                    { k: 'light', t: '浅色' },
                    { k: 'dark', t: '深色' },
                    { k: 'system', t: '跟随系统' }
                  ].map((item) => (
                    <button
                      key={item.k}
                      className={`seg-item${draft.appearance.theme === item.k ? ' is-active' : ''}`}
                      onClick={() => {
                        patch('appearance', { theme: item.k as 'light' | 'dark' | 'system' })
                        applyAppearance({ ...draft.appearance, theme: item.k as 'light' | 'dark' | 'system' })
                      }}
                    >
                      {item.t}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="主色调">
                <div className="accent-picker">
                  {[
                    { k: 'green', c: '#07c160' },
                    { k: 'blue', c: '#1e80ff' },
                    { k: 'purple', c: '#7c5cff' },
                    { k: 'orange', c: '#ff7a45' },
                    { k: 'rose', c: '#f43f5e' }
                  ].map((item) => (
                    <button
                      key={item.k}
                      className={`accent-dot${draft.appearance.accent === item.k ? ' is-on' : ''}`}
                      style={{ background: item.c }}
                      aria-label={item.k}
                      onClick={() => {
                        patch('appearance', { accent: item.k as 'green' })
                        applyAppearance({ ...draft.appearance, accent: item.k as 'green' })
                      }}
                    />
                  ))}
                </div>
              </Row>
              <Row label="封面圆角">
                <div className="set-inline">
                  <input
                    type="range"
                    min={0}
                    max={40}
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
              <Row label="封面宽度">
                <div className="set-inline">
                  <input
                    type="range"
                    min={100}
                    max={220}
                    step={4}
                    value={draft.appearance.gridMin}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      patch('appearance', { gridMin: v })
                      applyAppearance({ ...draft.appearance, gridMin: v })
                    }}
                  />
                  <span className="set-ro set-num">{draft.appearance.gridMin}px</span>
                </div>
              </Row>
              <Row label="圆角风格">
                <div className="seg">
                  {[
                    { k: 'squircle', t: '超椭圆' },
                    { k: 'round', t: '圆角' }
                  ].map((item) => (
                    <button
                      key={item.k}
                      className={`seg-item${draft.appearance.cornerStyle === item.k ? ' is-active' : ''}`}
                      onClick={() => {
                        patch('appearance', { cornerStyle: item.k as 'round' })
                        applyAppearance({ ...draft.appearance, cornerStyle: item.k as 'round' })
                      }}
                    >
                      {item.t}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="侧栏宽度">
                <div className="set-inline">
                  <input
                    type="range"
                    min={220}
                    max={380}
                    step={2}
                    value={draft.appearance.sidebarWidth}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      patch('appearance', { sidebarWidth: v })
                      applyAppearance({ ...draft.appearance, sidebarWidth: v })
                    }}
                  />
                  <span className="set-ro set-num">{draft.appearance.sidebarWidth}px</span>
                </div>
              </Row>
            </section>
          </>
        ) : null}

        {tab === 'library' ? (
          <section className="set-section">
            <h2 className="set-h2">书库</h2>
            <Row label="路径">
              <div className="set-inline">
                <span className="set-path" title={payload.path}>
                  {payload.path || '没找到书库'}
                </span>
                <button className="btn btn-sm" onClick={() => void pickLibrary()}>
                  更换
                </button>
              </div>
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
            <Row label="添加去重">
              <select
                className="select"
                value={draft.library.addMerge}
                onChange={(e) =>
                  patch('library', { addMerge: e.target.value as 'ignore' | 'overwrite' | 'new_record' })
                }
              >
                <option value="ignore">忽略重复</option>
                <option value="overwrite">覆盖已有格式</option>
                <option value="new_record">新建记录</option>
              </select>
            </Row>
            <Row label="导出路径模板">
              <input
                className="input"
                value={draft.library.exportTemplate}
                onChange={(e) => patch('library', { exportTemplate: e.target.value })}
              />
            </Row>
            <Row label="删除前备份">
              <Check
                checked={draft.library.trashBeforeDelete}
                onChange={(v) => patch('library', { trashBeforeDelete: v })}
                label="开启"
              />
            </Row>
            <Row label="回收站">
              <div className="set-inline">
                <span className="set-ro">{trash.length} 本</span>
                <button className="btn btn-sm" disabled={!trash.length || calibreRunning} onClick={() => void restoreTrash()}>
                  全部还原
                </button>
                <button className="btn btn-sm" disabled={!trash.length} onClick={() => void clearTrash()}>
                  清空
                </button>
              </div>
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
            <Row label="calibre 引擎">
              <span className="set-ro">{payload.calibreVersion ?? '未检测到'}</span>
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
              <Row label="输出配置文件">
                <select
                  className="select"
                  value={draft.convert.outputProfile}
                  onChange={(e) => patch('convert', { outputProfile: e.target.value })}
                >
                  <option value="">默认</option>
                  <option value="kindle_pw3">Kindle Paperwhite</option>
                  <option value="kindle_hidpi">Kindle 高清</option>
                  <option value="generic_eink">电子墨水</option>
                  <option value="generic_eink_hd">电子墨水高清</option>
                  <option value="tablet">平板</option>
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
                  onChange={(e) => patch('smtp', { user: e.target.value })}
                />
              </Row>
              <Row label="授权码">
                <div className="set-inline">
                  <input
                    className="input"
                    type="password"
                    value={password}
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
                  onChange={(e) => patch('smtp', { from: e.target.value })}
                />
              </Row>
              <Row label="Kindle 邮箱">
                <input
                  className="input"
                  value={draft.smtp.kindleEmail}
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
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    patch('web', { minCoverWidth: Number.isFinite(n) && n > 0 ? Math.min(4000, Math.round(n)) : 1 })
                  }}
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
