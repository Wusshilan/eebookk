import { useEffect, useMemo, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { Book, CustomColumn, EditResult, MetadataPatch, WebMetaHit } from '../../../shared/types'
import { useApp } from '../app/context'
import { htmlToText, textToHtml } from '../lib/cover'
import {
  METADATA_CSS, StarRating, cleanError, isValidDateInput, pubdateInput, splitLanguages, splitTags
} from './MetadataFields'

type ApplyResult = EditResult & { message?: string }

interface Draft {
  title: string
  authors: string
  authorSort: string
  series: string
  seriesIndex: string
  rating: number | null
  publisher: string
  pubdate: string
  languages: string
  tags: string
  comments: string
}

function draftFrom(book: Book): Draft {
  return {
    title: book.title,
    authors: book.authors,
    authorSort: book.authorSort ?? '',
    series: book.series ?? '',
    seriesIndex: book.series && book.seriesIndex != null ? String(book.seriesIndex) : '',
    rating: book.rating ? Math.max(1, Math.round(book.rating / 2)) : null,
    publisher: book.publisher ?? '',
    pubdate: pubdateInput(book.pubdate),
    languages: book.languages ? book.languages.split(',').map((s) => s.trim()).filter(Boolean).join(', ') : '',
    tags: book.tags.join(', '),
    comments: htmlToText(book.comments)
  }
}

function Field({
  label,
  error,
  children
}: {
  label: string
  error?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <label className="form-row">
      <span>{label}</span>
      {children}
      {error ? <em className="me-err">{error}</em> : null}
    </label>
  )
}

export default function MetadataEditor({
  book,
  onCancel
}: {
  book: Book
  onCancel: () => void
}): React.ReactElement {
  const { calibreRunning, reload, toast } = useApp()
  const [draft, setDraft] = useState<Draft>(() => draftFrom(book))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)

  const [ids, setIds] = useState<{ k: string; v: string }[]>(() =>
    Object.entries(book.identifiers).map(([k, v]) => ({ k, v }))
  )
  const [columns, setColumns] = useState<CustomColumn[]>([])
  const [custom, setCustom] = useState<Record<string, string>>(() => ({ ...(book.custom ?? {}) }))

  const [webQuery, setWebQuery] = useState(book.title)
  const [hits, setHits] = useState<WebMetaHit[]>([])
  const [looking, setLooking] = useState(false)
  const [lookError, setLookError] = useState('')

  useEffect(() => {
    window.api
      .invoke<CustomColumn[]>(CH.libraryColumns)
      .then((list) => setColumns(Array.isArray(list) ? list : []))
      .catch(() => setColumns([]))
  }, [])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const webLookup = async (): Promise<void> => {
    const q = webQuery.trim()
    if (!q) return
    setLooking(true)
    setLookError('')
    try {
      const list = await window.api.invoke<WebMetaHit[]>(CH.metaSearch, q)
      const arr = Array.isArray(list) ? list : []
      setHits(arr)
      if (arr.length === 0) setLookError('没搜到')
    } catch (e) {
      setLookError(String(e))
    } finally {
      setLooking(false)
    }
  }

  const fillFrom = (h: WebMetaHit): void => {
    setDraft((d) => ({
      ...d,
      title: h.title || d.title,
      authors: h.authors || d.authors,
      publisher: h.publisher || d.publisher,
      pubdate: h.pubdate || d.pubdate,
      languages: h.language || d.languages,
      comments: h.summary || d.comments
    }))
    if (h.isbn) {
      setIds((prev) =>
        prev.some((x) => x.k === 'isbn')
          ? prev.map((x) => (x.k === 'isbn' ? { ...x, v: h.isbn } : x))
          : [...prev, { k: 'isbn', v: h.isbn }]
      )
    }
    setHits([])
  }

  const save = async (): Promise<void> => {
    if (calibreRunning) {
      setSaveError('calibre 正在运行，写不进去')
      return
    }
    const next: Record<string, string> = {}
    if (!draft.title.trim()) next.title = '书名不能为空'
    if (draft.pubdate.trim() && !isValidDateInput(draft.pubdate.trim())) next.pubdate = '日期格式应为 YYYY-MM-DD'
    if (draft.seriesIndex.trim() && !draft.series.trim()) next.seriesIndex = '先填系列'
    if (draft.seriesIndex.trim() && !/^\d+(\.\d+)?$/.test(draft.seriesIndex.trim())) {
      next.seriesIndex = '序号填数字'
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return

    const patch: MetadataPatch = {
      title: draft.title.trim(),
      authors: draft.authors.split('&').map((s) => s.trim()).filter(Boolean),
      authorSort: draft.authorSort.trim() || null,
      series: draft.series.trim() || null,
      seriesIndex: draft.series.trim() && draft.seriesIndex.trim() ? Number(draft.seriesIndex) : null,
      publisher: draft.publisher.trim() || null,
      pubdate: draft.pubdate.trim() || null,
      languages: splitLanguages(draft.languages),
      tags: splitTags(draft.tags),
      rating: draft.rating ? draft.rating * 2 : null,
      comments: draft.comments.trim() ? textToHtml(draft.comments.trim()) : null
    }

    const idMap: Record<string, string> = {}
    for (const row of ids) {
      const k = row.k.trim()
      const v = row.v.trim()
      if (!k || !v) continue
      // calibredb 用逗号分隔标识符、用冒号分隔键值，带了就会把整组写坏
      if (k.includes(',') || k.includes(':')) {
        next.ids = `标识符名「${k}」不能包含逗号或冒号`
        return
      }
      if (v.includes(',')) {
        next.ids = `标识符「${k}」的值不能包含逗号`
        return
      }
      idMap[k] = v
    }
    patch.identifiers = idMap

    if (columns.length > 0) {
      const customPatch: Record<string, string | null> = {}
      for (const col of columns) {
        const v = (custom[col.label] ?? '').trim()
        // 空值也要提交，否则自定义列永远清不掉；本来就没有值的不用发
        if (v) customPatch[col.label] = v
        else if ((book.custom?.[col.label] ?? '') !== '') customPatch[col.label] = null
      }
      if (Object.keys(customPatch).length > 0) patch.custom = customPatch
    }

    setSaving(true)
    setSaveError('')
    try {
      const res = await window.api.invoke<ApplyResult>(CH.metadataApply, [book.id], patch)
      if (!res.ok) {
        const first = res.failed?.[0]?.error
        setSaveError(first ? cleanError(first) : res.message || '保存失败')
        return
      }
      toast('元数据已保存')
      await reload()
      onCancel()
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const filled = useMemo(() => columns.filter((c) => c.datatype !== 'composite'), [columns])

  return (
    <div className="edit-form">
      <style>{METADATA_CSS}</style>

      {calibreRunning ? <div className="warn-box">calibre 正在运行，书库被它锁着</div> : null}

      <div className="me-web">
        <input
          className="input"
          value={webQuery}
          onChange={(e) => setWebQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void webLookup()
          }}
        />
        <button className="btn btn-sm" disabled={looking} onClick={() => void webLookup()}>
          {looking ? '查找中' : '全网查找'}
        </button>
        {lookError ? <em className="me-err">{lookError}</em> : null}
      </div>

      {hits.length > 0 ? (
        <div className="me-hits">
          {hits.map((h) => (
            <button
              type="button"
              key={`${h.source}-${h.id}`}
              className="me-hit"
              onClick={() => fillFrom(h)}
            >
              {h.coverUrl ? (
                <img src={h.coverUrl} alt="" width={48} height={64} />
              ) : (
                <span className="me-hit-noimg" />
              )}
              <span className="me-hit-body">
                <span className="me-hit-title">{h.title}</span>
                <span className="me-hit-sub">{h.authors}</span>
                <span className="me-hit-sub">{[h.publisher, h.pubdate].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="me-hit-side">
                <span className="me-hit-src">{h.sourceName}</span>
                {h.coverWidth && h.coverHeight ? (
                  <span className="me-hit-res">
                    {h.coverWidth}x{h.coverHeight}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="me-grid">
        <Field label="书名" error={errors.title}>
          <input className="input" value={draft.title} onChange={(e) => set('title', e.target.value)} />
        </Field>

        <Field label="作者">
          <input className="input" value={draft.authors} onChange={(e) => set('authors', e.target.value)} />
        </Field>

        <Field label="作者排序">
          <input className="input" value={draft.authorSort} onChange={(e) => set('authorSort', e.target.value)} />
        </Field>

        <Field label="系列">
          <input className="input" value={draft.series} onChange={(e) => set('series', e.target.value)} />
        </Field>

        <Field label="系列序号" error={errors.seriesIndex}>
          <input
            className="input"
            inputMode="decimal"
            value={draft.seriesIndex}
            onChange={(e) => set('seriesIndex', e.target.value)}
          />
        </Field>

        <Field label="出版社">
          <input className="input" value={draft.publisher} onChange={(e) => set('publisher', e.target.value)} />
        </Field>

        <Field label="出版日期" error={errors.pubdate}>
          <input className="input" value={draft.pubdate} onChange={(e) => set('pubdate', e.target.value)} />
        </Field>

        <Field label="语言">
          <input className="input" value={draft.languages} onChange={(e) => set('languages', e.target.value)} />
        </Field>

        <Field label="评分">
          <StarRating value={draft.rating} onChange={(v) => set('rating', v)} />
        </Field>

        <Field label="标签">
          <input className="input" value={draft.tags} onChange={(e) => set('tags', e.target.value)} />
        </Field>

        {filled.map((col) => (
          <Field key={col.label} label={col.name || col.label}>
            {col.datatype === 'bool' ? (
              <select
                className="select"
                value={custom[col.label] ?? ''}
                onChange={(e) => setCustom((p) => ({ ...p, [col.label]: e.target.value }))}
              >
                <option value="">否</option>
                <option value="1">是</option>
              </select>
            ) : col.datatype === 'enumeration' && col.options.length > 0 ? (
              <select
                className="select"
                value={custom[col.label] ?? ''}
                onChange={(e) => setCustom((p) => ({ ...p, [col.label]: e.target.value }))}
              >
                <option value="" />
                {col.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                value={custom[col.label] ?? ''}
                onChange={(e) => setCustom((p) => ({ ...p, [col.label]: e.target.value }))}
              />
            )}
          </Field>
        ))}
      </div>

      <div className="me-ids">
        <div className="me-ids-head">标识符</div>
        {errors.ids ? <em className="me-err">{errors.ids}</em> : null}
        {ids.map((row, i) => (
          <div className="me-id-row" key={`id-${i}`}>
            <input
              className="input me-id-key"
              value={row.k}
              onChange={(e) => setIds((p) => p.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
            />
            <input
              className="input"
              value={row.v}
              onChange={(e) => setIds((p) => p.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
            />
            <button type="button" className="btn btn-sm" onClick={() => setIds((p) => p.filter((_, j) => j !== i))}>
              删除
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setIds((p) => [...p, { k: '', v: '' }])}>
          添加标识符
        </button>
      </div>

      <label className="form-row">
        <span>简介</span>
        <textarea
          className="textarea"
          rows={9}
          value={draft.comments}
          onChange={(e) => set('comments', e.target.value)}
        />
      </label>

      {saveError ? <div className="warn-box">{saveError}</div> : null}

      <div className="me-actions">
        <button className="btn btn-primary" disabled={saving || calibreRunning} onClick={() => void save()}>
          {saving ? '保存中' : '保存'}
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
