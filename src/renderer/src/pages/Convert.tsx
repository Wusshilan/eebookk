import { useEffect, useMemo, useState } from 'react'
import type { ConvertJob } from '../../../shared/types'
import { CH } from '../../../shared/ipc'
import { useApp } from '../app/context'
import { coverUrl, formatBytes } from '../lib/cover'
import { IconConvert, IconStop, IconTrash } from '../icons'
import {
  STATUS_COLOR, STATUS_LABEL, TARGETS, TARGET_LABEL,
  formatElapsed, useNow, useTaskSnapshot
} from '../components/ConvertShared'

interface EnqueueResult {
  ok: boolean
  added: number
  skipped: number
  message?: string
}

const CSS = `
.cv-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 396px;
  gap: 16px;
  align-items: start;
}
.cv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 8px -6px 0;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
}
.cv-row:hover { background: #f7f7f7; }
.cv-row.is-picked { background: var(--accent-weak); }
.cv-thumb {
  width: 26px;
  height: 36px;
  flex: none;
  border-radius: 3px;
  object-fit: cover;
  background: #f0f0f0;
}
.cv-row-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.cv-row-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-row-sub { font-size: 11px; color: var(--t2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--t2);
  cursor: pointer;
  user-select: none;
}
.cv-more {
  margin-top: 6px;
  text-align: left;
  font-size: 12px;
  color: var(--accent);
}
.cv-more:hover { color: var(--accent-press); }
.cv-note { font-size: 11px; color: #b0b0b0; margin-top: 4px; }
.cv-nowrap { white-space: nowrap; }
`

/** 队列里的排列顺序：正在跑 → 排队 → 已结束（新的在上） */
function orderJobs(list: ConvertJob[]): ConvertJob[] {
  const rank = (job: ConvertJob): number => {
    if (job.status === 'running') return 0
    if (job.status === 'queued') return 1
    return 2
  }
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt) ||
      b.createdAt - a.createdAt
  )
}

export default function Convert(): React.ReactElement {
  const { books, invoke, toast } = useApp()
  const snap = useTaskSnapshot()
  const [target, setTarget] = useState<string>('epub')
  const [picked, setPicked] = useState<number[]>([])
  const [keyword, setKeyword] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [showAll, setShowAll] = useState(false)

  // 默认目标格式跟随设置页（还没实现时回落到 epub）
  useEffect(() => {
    let alive = true
    window.api
      .invoke<{ convert?: { defaultTarget?: string } }>(CH.settingsGet)
      .then((settings) => {
        const next = settings?.convert?.defaultTarget
        if (alive && next) setTarget(next.toLowerCase())
      })
      .catch(() => {
        /* 设置读不到就用 epub */
      })
    return () => {
      alive = false
    }
  }, [])

  const converts = snap?.converts ?? []
  const runningCount = converts.filter((job) => job.status === 'running').length
  const queuedCount = converts.filter((job) => job.status === 'queued').length
  const finishedCount = converts.filter(
    (job) => job.status === 'done' || job.status === 'failed' || job.status === 'canceled'
  ).length

  const now = useNow(runningCount > 0)
  const ordered = useMemo(() => orderJobs(converts), [converts])

  const candidates = useMemo(() => {
    const upper = target.toUpperCase()
    const kw = keyword.trim().toLowerCase()
    let list = books
    if (onlyMissing) list = list.filter((book) => !book.formats.includes(upper))
    if (kw) {
      list = list.filter(
        (book) =>
          book.title.toLowerCase().includes(kw) ||
          book.authors.toLowerCase().includes(kw)
      )
    }
    return list
  }, [books, keyword, onlyMissing, target])

  const visible = showAll ? candidates : candidates.slice(0, 60)

  const toggle = (id: number): void => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const selectVisible = (): void => {
    setPicked((prev) => {
      const merged = new Set(prev)
      for (const book of visible) merged.add(book.id)
      return [...merged]
    })
  }

  const onEnqueue = async (): Promise<void> => {
    if (!picked.length) return
    try {
      const res = await invoke<EnqueueResult>(CH.convertEnqueue, picked, target)
      if (res.ok) {
        const skipped = res.skipped ? `，跳过 ${res.skipped} 本` : ''
        toast(`已加入 ${res.added} 个转换任务${skipped}`, 'success')
        setPicked([])
      } else {
        toast(res.message ?? '入队失败', 'error')
      }
    } catch (e) {
      toast(`入队失败：${String(e)}`, 'error')
    }
  }

  const onCancel = async (jobId: string): Promise<void> => {
    try {
      const res = await invoke<{ ok: boolean; message?: string }>(CH.convertCancel, jobId)
      if (!res.ok) toast(res.message ?? '取消失败', 'error')
    } catch (e) {
      toast(`取消失败：${String(e)}`, 'error')
    }
  }

  const onClearFinished = async (): Promise<void> => {
    try {
      const res = await invoke<{ ok: boolean; removed: number }>(CH.convertClearFinished)
      if (res.removed > 0) toast(`清掉了 ${res.removed} 条已结束任务`, 'success')
      else toast('没有可清除的任务')
    } catch (e) {
      toast(`清除失败：${String(e)}`, 'error')
    }
  }

  return (
    <div className="page">
      <style>{CSS}</style>

      <div className="page-head">
        <h1 className="page-title">转换</h1>
        <span className="page-sub">
          {runningCount > 0 ? `${runningCount} 个转换中 · ` : ''}
          {queuedCount > 0 ? `${queuedCount} 个排队 · ` : ''}
          共 {converts.length} 个任务
        </span>
        <span className="spacer" />
        <label className="page-sub" style={{ fontSize: 13 }}>
          目标格式
        </label>
        <select
          className="select"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          title="ebook-convert 靠输出文件扩展名决定目标格式"
        >
          {TARGETS.map((format) => (
            <option key={format} value={format}>
              {TARGET_LABEL[format]}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={picked.length === 0} onClick={onEnqueue}>
          <IconConvert width={17} height={17} />
          {picked.length > 0 ? `转换所选 ${picked.length} 本` : '转换所选'}
        </button>
      </div>

      <div className="cv-grid">
        <div className="panel" style={{ padding: '14px 16px', minHeight: 320 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span className="panel-title" style={{ margin: 0 }}>
              转换队列
            </span>
            <span className="page-sub" style={{ fontSize: 12 }}>
              并发 2 · 输出到用户目录 exports/
            </span>
            <span className="spacer" />
            <button
              className="btn btn-sm btn-ghost"
              disabled={finishedCount === 0}
              onClick={onClearFinished}
            >
              <IconTrash width={15} height={15} />
              清除已结束
            </button>
          </div>

          {ordered.length === 0 ? (
            <div className="empty" style={{ padding: '56px 0' }}>
              还没有转换任务
              <br />
              <span style={{ fontSize: 13 }}>在右侧从书库选几本，选好目标格式后入队</span>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>书名</th>
                  <th style={{ width: 120 }}>格式</th>
                  <th style={{ width: 84 }}>状态</th>
                  <th style={{ width: 210 }}>进度</th>
                  <th style={{ width: 96 }}>耗时</th>
                  <th style={{ width: 78 }} />
                </tr>
              </thead>
              <tbody>
                {ordered.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <div className="cell-title" style={{ maxWidth: 340 }} title={job.title}>
                        {job.title}
                      </div>
                      {job.message ? (
                        <div
                          className="cell-muted"
                          title={job.message}
                          style={{
                            maxWidth: 340,
                            fontSize: 12,
                            color: job.status === 'failed' ? 'var(--badge)' : undefined,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {job.message}
                        </div>
                      ) : null}
                    </td>
                    <td className="cell-muted cv-nowrap">
                      {job.from} → {job.to.toUpperCase()}
                    </td>
                    <td className="cv-nowrap">
                      <span
                        style={{ fontSize: 13, fontWeight: 500, color: STATUS_COLOR[job.status] }}
                      >
                        {STATUS_LABEL[job.status]}
                      </span>
                    </td>
                    <td>
                      <div className="progress">
                        <i style={{ width: `${job.percent}%` }} />
                      </div>
                      <div
                        className="cell-muted"
                        title={job.stage}
                        style={{
                          fontSize: 11,
                          marginTop: 3,
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {job.percent > 0 ? `${job.percent}% · ` : ''}
                        {job.stage || '—'}
                      </div>
                    </td>
                    <td className="cell-muted cv-nowrap">{formatElapsed(job, now)}</td>
                    <td className="cv-nowrap">
                      {job.status === 'queued' || job.status === 'running' ? (
                        <button className="btn btn-sm btn-ghost" onClick={() => onCancel(job.id)}>
                          <IconStop width={13} height={13} />
                          取消
                        </button>
                      ) : job.outputPath ? (
                        <button
                          className="btn btn-sm btn-ghost"
                          style={{ fontSize: 12 }}
                          title={job.outputPath}
                          onClick={() =>
                            void window.api.invoke(CH.revealPath, job.outputPath).then((r) => {
                              const res = r as { ok: boolean; message: string }
                              if (!res.ok) toast(res.message, 'error')
                            })
                          }
                        >
                          打开所在文件夹
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', height: 560 }}>
          <div className="panel-title">从书库选择</div>


          <input
            className="input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />

          <label className="cv-check">
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(e) => setOnlyMissing(e.target.checked)}
            />
            只看缺少 {TARGET_LABEL[target]} 的书
          </label>

          <div className="cv-list">
            {visible.length === 0 ? (
              <div className="empty" style={{ padding: '30px 0', fontSize: 13 }}>
                没有符合条件的书
              </div>
            ) : (
              visible.map((book) => {
                const isPicked = picked.includes(book.id)
                return (
                  <label key={book.id} className={`cv-row${isPicked ? ' is-picked' : ''}`}>
                    <input type="checkbox" checked={isPicked} onChange={() => toggle(book.id)} />
                    <img className="cv-thumb" src={coverUrl(book.id)} alt="" loading="lazy" draggable={false} />
                    <span className="cv-row-main">
                      <span className="cv-row-title" title={book.title}>
                        {book.title}
                      </span>
                      <span className="cv-row-sub">
                        {book.authors || '佚名'} · {book.formats.join(' / ') || '无格式'} ·{' '}
                        {formatBytes(book.sizeBytes)}
                      </span>
                    </span>
                  </label>
                )
              })
            )}
            {candidates.length > visible.length ? (
              <button className="cv-more" onClick={() => setShowAll(true)}>
                还有 {candidates.length - visible.length} 本，显示全部
              </button>
            ) : null}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 10 }}>
            <span className="page-sub" style={{ fontSize: 13 }}>
              已选 {picked.length} 本
            </span>
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" disabled={visible.length === 0} onClick={selectVisible}>
              全选当前
            </button>
            <button className="btn btn-sm btn-ghost" disabled={picked.length === 0} onClick={() => setPicked([])}>
              清空
            </button>
          </div>
        </div>
      </div>

      <div className="cv-note">
        转换由本机 calibre 的 ebook-convert 完成，calibre 开着也能跑；输出文件在用户目录下的 eebookk/exports/。
      </div>
    </div>
  )
}
