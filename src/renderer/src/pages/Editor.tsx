import { useEffect, useMemo, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { EpubFileContent, EpubFileEntry } from '../../../shared/types'
import { useApp } from '../app/context'

/** 主进程 reject 出来的错误带着一长串前缀，剥掉只留人话 */
function clean(e: unknown): string {
  const s = String(e)
  return s.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

const KIND_LABEL: Record<string, string> = {
  html: '正文',
  css: '样式',
  opf: '书脊',
  image: '图片',
  font: '字体',
  other: '其他'
}

const KIND_ORDER = ['opf', 'html', 'css', 'image', 'font', 'other']

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function Editor({ id }: { id: number }): React.ReactElement {
  const { books, navigate, calibreRunning, reload, toast } = useApp()
  const book = books.find((b) => b.id === id)

  const [files, setFiles] = useState<EpubFileEntry[]>([])
  const [current, setCurrent] = useState<string>('')
  const [content, setContent] = useState<EpubFileContent | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [backups, setBackups] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    window.api
      .invoke<EpubFileEntry[]>(CH.epubList, id)
      .then((list) => {
        if (!alive) return
        const arr = Array.isArray(list) ? list : []
        setFiles(arr)
        const first = arr.find((f) => f.editable)
        if (first) void open(first.path)
      })
      .catch((e: unknown) => alive && setError(clean(e)))
    window.api
      .invoke<string[]>(CH.epubBackupList, id)
      .then((list) => alive && setBackups(Array.isArray(list) ? list : []))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [id])

  const open = async (path: string): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const res = await window.api.invoke<EpubFileContent>(CH.epubRead, id, path)
      setCurrent(path)
      setContent(res)
      setDirty(false)
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!content || content.status !== 'ok') return
    setBusy(true)
    setError('')
    try {
      const res = await window.api.invoke<{ ok: boolean; message: string }>(
        CH.epubWrite,
        id,
        content.path,
        content.text
      )
      if (!res.ok) {
        setError(res.message || '保存失败')
        return
      }
      toast(res.message || '已保存')
      setDirty(false)
      const list = await window.api.invoke<EpubFileEntry[]>(CH.epubList, id)
      setFiles(Array.isArray(list) ? list : [])
      const bk = await window.api.invoke<string[]>(CH.epubBackupList, id)
      setBackups(Array.isArray(bk) ? bk : [])
      await reload()
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }

  const revert = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const res = await window.api.invoke<{ ok: boolean; message: string }>(CH.epubRevert, id)
      toast(res.message || (res.ok ? '已还原' : '还原失败'), res.ok ? 'success' : 'error')
      if (res.ok) {
        setDirty(false)
        if (current) await open(current)
        await reload()
      }
    } finally {
      setBusy(false)
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, EpubFileEntry[]>()
    for (const f of files) {
      const arr = map.get(f.kind) ?? []
      arr.push(f)
      map.set(f.kind, arr)
    }
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as const)
  }, [files])

  if (!book) {
    return (
      <div className="page">
        <div className="empty" />
      </div>
    )
  }

  return (
    <div className="page page-editor">
      <div className="ed-head">
        <button className="btn btn-sm" onClick={() => navigate({ name: 'book', id })}>
          返回
        </button>
        <span className="ed-title">{book.title}</span>
        <span className="spacer" />
        {dirty ? <span className="ed-dirty">未保存</span> : null}
        <button className="btn btn-sm" disabled={busy} onClick={() => void revert()}>
          还原上一版
        </button>
        <button
          className="btn btn-sm btn-primary"
          disabled={busy || !dirty || calibreRunning || content?.status !== 'ok'}
          onClick={() => void save()}
        >
          {busy ? '处理中' : '保存'}
        </button>
      </div>

      <div className="ed-body">
        <aside className="ed-tree">
          {grouped.map(([kind, list]) => (
            <div key={kind} className="ed-group">
              <div className="ed-group-head">
                {KIND_LABEL[kind] ?? kind} · {list.length}
              </div>
              {list.map((f) => (
                <button
                  key={f.path}
                  className={`ed-file${current === f.path ? ' is-active' : ''}${f.editable ? '' : ' is-locked'}`}
                  disabled={!f.editable}
                  onClick={() => void open(f.path)}
                  title={f.path}
                >
                  <span className="ed-file-name">{f.name}</span>
                  <span className="ed-file-size">{bytes(f.size)}</span>
                </button>
              ))}
            </div>
          ))}
          {backups.length > 0 ? (
            <div className="ed-group">
              <div className="ed-group-head">备份 · {backups.length}</div>
              {backups.slice(0, 5).map((b) => (
                <div key={b} className="ed-file ed-backup" title={b}>
                  <span className="ed-file-name">{b}</span>
                </div>
              ))}
            </div>
          ) : null}
        </aside>

        <section className="ed-main">
          {error ? <div className="warn-box">{error}</div> : null}
          {content?.status === 'ok' ? (
            <textarea
              className="ed-code"
              spellCheck={false}
              value={content.text}
              onChange={(e) => {
                setContent({ ...content, text: e.target.value })
                setDirty(true)
              }}
            />
          ) : content ? (
            <div className="ed-blocked">
              {content.path} · {bytes(content.bytes)}
            </div>
          ) : (
            <div className="ed-blocked" />
          )}
          <div className="ed-foot">
            <span className="ed-path">{content?.path ?? ''}</span>
            <span className="spacer" />
            {content?.status === 'ok' ? (
              <span className="ed-stat">
                {content.text.split('\n').length} 行 · {bytes(content.bytes)}
              </span>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
