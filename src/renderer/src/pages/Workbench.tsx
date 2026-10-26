import { useCallback, useEffect, useMemo, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { QualityIssue, QualityReport, TagStat } from '../../../shared/types'
import { useApp } from '../app/context'
import { coverUrl } from '../lib/cover'
import { IconCheck, IconRefresh, IconSliders, IconTrash } from '../icons'
import MetadataBatchEdit from '../components/MetadataBatchEdit'

const SEVERITY_LABEL: Record<QualityIssue['severity'], string> = {
  high: '高',
  medium: '中',
  low: '低'
}

export default function Workbench(): React.ReactElement {
  const { books, stats, calibreRunning, reload, navigate, toast, setSelected, selected } = useApp()
  const [report, setReport] = useState<QualityReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeIssue, setActiveIssue] = useState<string | null>(null)
  const [pickedTags, setPickedTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [pickedBooks, setPickedBooks] = useState<number[]>([])
  const [focusBatch, setFocusBatch] = useState(false)

  // 从问题清单点「批量编辑」后滚到下面的面板，免得用户找
  useEffect(() => {
    if (activeIssue !== null || !focusBatch) return
    document.getElementById('wb-batch')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFocusBatch(false)
  }, [activeIssue, focusBatch])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.api.invoke<QualityReport>(CH.qualityReport)
      setReport(r)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, books.length])

  const issue = useMemo(
    () => report?.issues.find((i) => i.key === activeIssue) ?? null,
    [report, activeIssue]
  )

  const issueBooks = useMemo(() => {
    if (!issue) return []
    const set = new Set(issue.bookIds)
    return books.filter((b) => set.has(b.id))
  }, [issue, books])

  const suspiciousTags = useMemo(() => (report?.tags ?? []).filter((t) => t.suspicious), [report])

  const cleanTags = async (): Promise<void> => {
    if (!pickedTags.length) return
    if (calibreRunning) {
      toast('calibre 正在运行，无法写入。请先关闭 calibre。', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.invoke<{ ok: boolean; updated: number; message?: string }>(CH.tagsCleanup, {
        remove: pickedTags
      })
      if (res.ok) {
        toast(`已清理 ${pickedTags.length} 个标签，涉及 ${res.updated} 本书`, 'success')
        setPickedTags([])
        await load()
        await reload()
      } else {
        toast(res.message ?? '清理失败', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const moveToPage = (issueKey: string, ids: number[]): void => {
    setSelected(ids)
    if (issueKey === 'no-epub') navigate({ name: 'convert' })
    else navigate({ name: 'library' })
  }

  /** 把一批书交给下面的批量编辑面板，并滚过去 */
  const editBatch = (ids: number[]): void => {
    setSelected(ids)
    setActiveIssue(null)
    setFocusBatch(true)
  }

  if (loading && !report) return <div className="page"><div className="empty">正在扫描书库…</div></div>
  if (!report) return <div className="page"><div className="empty">扫描失败</div></div>

  const scoreColor = report.score >= 80 ? 'var(--accent)' : report.score >= 55 ? '#e8a33d' : '#e34747'

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">整理台</h1>
        <span className="page-sub">扫描 {report.total} 本</span>
        <span className="spacer" />
        {selected.length > 0 ? (
          <button className="btn btn-sm" onClick={() => editBatch(selected)}>
            <IconSliders width={16} height={16} />
            批量编辑已选 {selected.length} 本
          </button>
        ) : null}
        {calibreRunning ? <span className="lock-pill">calibre 运行中 · 只读</span> : null}
        <button className="btn btn-sm btn-ghost" onClick={() => void load()}>
          <IconRefresh width={16} height={16} />
          重新扫描
        </button>
      </div>

      {!activeIssue ? (
        <>
          <div className="score-row">
            <div className="score-card">
              <div className="score-ring" style={{ ['--score-color' as string]: scoreColor }}>
                <span className="score-num">{report.score}</span>
                <span className="score-unit">分</span>
              </div>
              <div className="score-text">
                <div className="score-title">书库健康度</div>
                <div className="score-desc">
                  {report.score >= 80
                    ? '底子不错，补一补细节就干净了'
                    : report.score >= 55
                      ? '能用，但元数据还有明显缺口'
                      : '元数据大面积缺失，建议优先跑一遍整理'}
                </div>
              </div>
            </div>
            <div className="stat-row">
              <div className="stat">
                <b>{stats.total}</b>
                <span>藏书</span>
              </div>
              <div className="stat">
                <b>{stats.withDesc}</b>
                <span>有简介</span>
              </div>
              <div className="stat">
                <b>{stats.withTags}</b>
                <span>有标签</span>
              </div>
              <div className="stat">
                <b>{stats.withCover}</b>
                <span>有封面</span>
              </div>
              <div className="stat">
                <b>{stats.started}</b>
                <span>读过</span>
              </div>
            </div>
          </div>

          <h2 className="wb-h2">问题清单</h2>
          <div className="issue-grid">
            {report.issues.map((it) => (
              <button
                key={it.key}
                className={`issue-card sev-${it.severity}${it.count === 0 ? ' is-clean' : ''}`}
                onClick={() => {
                  if (it.count === 0) return
                  setActiveIssue(it.key)
                  setPickedBooks(it.bookIds)
                }}
              >
                <div className="issue-top">
                  <span className="issue-count">{it.count}</span>
                  <span className="issue-sev">{SEVERITY_LABEL[it.severity]}</span>
                </div>
                <div className="issue-label">{it.label}</div>
              </button>
            ))}
          </div>

          <h2 className="wb-h2">
            水印标签
            <span className="wb-h2-sub">共 {suspiciousTags.length} 个</span>
          </h2>
          {suspiciousTags.length > 0 ? (
            <div className="panel">
              <div className="tag-pick-grid">
                {suspiciousTags.map((t: TagStat) => (
                  <label key={t.name} className={`tag-pick${pickedTags.includes(t.name) ? ' is-on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={pickedTags.includes(t.name)}
                      onChange={() =>
                        setPickedTags((prev) =>
                          prev.includes(t.name) ? prev.filter((x) => x !== t.name) : [...prev, t.name]
                        )
                      }
                    />
                    <span className="tag-pick-name">{t.name}</span>
                    <span className="tag-pick-count">{t.count} 本</span>
                    <span className="tag-pick-reason">{t.reason}</span>
                  </label>
                ))}
              </div>
              <div className="form-actions" style={{ marginTop: 14 }}>
                <button
                  className="btn btn-primary"
                  disabled={!pickedTags.length || busy || calibreRunning}
                  onClick={() => void cleanTags()}
                >
                  <IconTrash width={16} height={16} />
                  {busy ? '清理中…' : `清理选中的 ${pickedTags.length} 个标签`}
                </button>
                <button
                  className="btn"
                  disabled={!suspiciousTags.length}
                  onClick={() => setPickedTags(suspiciousTags.map((t) => t.name))}
                >
                  全选
                </button>
                <button className="btn" disabled={!pickedTags.length} onClick={() => setPickedTags([])}>
                  清空选择
                </button>
              </div>
            </div>
          ) : null}

          <div id="wb-batch" style={{ scrollMarginTop: 16 }}>
            <MetadataBatchEdit issues={report.issues} onApplied={() => void load()} />
          </div>
        </>
      ) : (
        <>
          <div className="page-head" style={{ marginBottom: 10 }}>
            <button className="btn btn-sm" onClick={() => setActiveIssue(null)}>
              ← 返回总览
            </button>
            <h2 className="wb-h2-inline">{issue?.label}</h2>
            <span className="page-sub">{issueBooks.length} 本</span>
            <span className="spacer" />
            <button className="btn btn-sm" onClick={() => setPickedBooks(issueBooks.map((b) => b.id))}>
              全选
            </button>
            <button
              className="btn btn-sm"
              onClick={() => editBatch(pickedBooks.length ? pickedBooks : issueBooks.map((b) => b.id))}
            >
              <IconSliders width={16} height={16} />
              批量编辑
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => issue && moveToPage(issue.key, pickedBooks.length ? pickedBooks : issueBooks.map((b) => b.id))}
            >
              <IconSliders width={16} height={16} />
              去处理（{pickedBooks.length || issueBooks.length} 本）
            </button>
          </div>

          <div className="grid grid-dense">
            {issueBooks.map((b) => (
              <article
                key={b.id}
                className={`card${pickedBooks.includes(b.id) ? ' is-selected' : ''}`}
                onClick={() => navigate({ name: 'book', id: b.id })}
                title={b.title}
              >
                <img src={coverUrl(b.id)} alt={b.title} loading="lazy" draggable={false} />
                <div
                  className="card-check"
                  onClick={(e) => {
                    e.stopPropagation()
                    setPickedBooks((prev) =>
                      prev.includes(b.id) ? prev.filter((x) => x !== b.id) : [...prev, b.id]
                    )
                  }}
                >
                  <IconCheck width={13} height={13} />
                </div>
                <div className="card-meta">
                  <div className="card-title">{b.title}</div>
                  <div className="card-author">{b.authors || '佚名'}</div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
