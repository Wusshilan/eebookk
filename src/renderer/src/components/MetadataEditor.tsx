import { useMemo, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { Book, EditResult, MetadataPatch } from '../../../shared/types'
import { useApp } from '../app/context'
import { htmlToText, textToHtml } from '../lib/cover'
import {
  CopyText, METADATA_CSS, StarRating, badLanguage, cleanError, isValidDateInput,
  pubdateInput, splitLanguages, splitTags
} from './MetadataFields'

type ApplyResult = EditResult & { message?: string }

interface Draft {
  title: string
  authors: string
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
    series: book.series ?? '',
    // calibre 给没有系列的书也留了个 series_index=1，别把它带进表单
    seriesIndex: book.series && book.seriesIndex != null ? String(book.seriesIndex) : '',
    rating: book.rating ? Math.max(1, Math.round(book.rating / 2)) : null,
    publisher: book.publisher ?? '',
    pubdate: pubdateInput(book.pubdate),
    languages: book.languages ? book.languages.split(',').map((s) => s.trim()).filter(Boolean).join(', ') : '',
    tags: book.tags.join(', '),
    comments: htmlToText(book.comments)
  }
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

  // 详情页用 key={book.id} 挂载，换书时自然重置草稿
  const ids = useMemo(() => Object.entries(book.identifiers), [book.identifiers])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const save = async (): Promise<void> => {
    if (calibreRunning) {
      setSaveError('calibre 正在运行，写不进去。关掉 calibre 再保存。')
      return
    }
    const nextErrors: Record<string, string> = {}
    const title = draft.title.trim()
    if (!title) nextErrors.title = '书名不能为空'

    const series = draft.series.trim()
    let seriesIndex: number | null = null
    const seriesIndexRaw = draft.seriesIndex.trim()
    if (seriesIndexRaw) {
      if (!/^\d+(\.\d+)?$/.test(seriesIndexRaw)) nextErrors.seriesIndex = '序号填数字，可以带小数'
      else if (!series) nextErrors.seriesIndex = '先填系列名，再填序号'
      else seriesIndex = Number(seriesIndexRaw)
    }

    const pubdate = draft.pubdate.trim()
    if (pubdate && !isValidDateInput(pubdate)) {
      nextErrors.pubdate = '按 yyyy-mm-dd 填，比如 2008-05-01'
    }
    const badLang = badLanguage(draft.languages)
    if (badLang) nextErrors.languages = `「${badLang}」不像语言码，用 chi、zh、eng 这种`

    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      setSaveError('')
      return
    }
    setErrors({})
    setSaveError('')

    const patch: MetadataPatch = {
      title,
      authors: draft.authors.split('&').map((s) => s.trim()).filter(Boolean),
      series: series || null,
      seriesIndex,
      rating: draft.rating == null ? null : draft.rating * 2,
      publisher: draft.publisher.trim() || null,
      pubdate: pubdate || null,
      languages: splitLanguages(draft.languages),
      tags: splitTags(draft.tags),
      comments: textToHtml(draft.comments)
    }

    setSaving(true)
    try {
      const res = await window.api.invoke<ApplyResult>(CH.metadataApply, [book.id], patch)
      if (res.ok && res.updated > 0) {
        toast('已保存', 'success')
        await reload()
        onCancel()
        return
      }
      setSaveError(cleanError(res.message ?? res.failed[0]?.error ?? '没有字段被写入'))
      toast('保存失败', 'error')
    } catch (e) {
      setSaveError(cleanError(e instanceof Error ? e.message : String(e)))
      toast('保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="edit-form">
      <style>{METADATA_CSS}</style>

      {calibreRunning ? (
        <div className="warn-box">
          calibre 正在运行，书库被它锁着。关掉 calibre 再回来保存，现在改了也会失败。
        </div>
      ) : null}

      <div className="me-grid">
        <label className="form-row">
          <span>书名</span>
          <input
            className="input"
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
          />
          {errors.title ? <em className="me-err">{errors.title}</em> : null}
        </label>

        <label className="form-row">
          <span>作者（多作者用 & 分隔）</span>
          <input
            className="input"
            value={draft.authors}
            placeholder="曹雪芹 & 高鹗"
            onChange={(e) => set('authors', e.target.value)}
          />
        </label>

        <label className="form-row">
          <span>系列</span>
          <input
            className="input"
            value={draft.series}
            placeholder="留空即不在任何系列"
            onChange={(e) => set('series', e.target.value)}
          />
        </label>

        <label className="form-row">
          <span>系列序号</span>
          <input
            className="input"
            value={draft.seriesIndex}
            inputMode="decimal"
            placeholder="留空即清空"
            onChange={(e) => set('seriesIndex', e.target.value)}
          />
          {errors.seriesIndex ? <em className="me-err">{errors.seriesIndex}</em> : null}
        </label>

        <label className="form-row">
          <span>出版社</span>
          <input
            className="input"
            value={draft.publisher}
            placeholder="留空即清空"
            onChange={(e) => set('publisher', e.target.value)}
          />
        </label>

        <label className="form-row">
          <span>出版日期（yyyy-mm-dd）</span>
          <input
            className="input"
            value={draft.pubdate}
            placeholder="2008-05-01，留空即未知"
            onChange={(e) => set('pubdate', e.target.value)}
          />
          {errors.pubdate ? <em className="me-err">{errors.pubdate}</em> : null}
        </label>

        <label className="form-row">
          <span>语言（ISO 码，多个用逗号）</span>
          <input
            className="input"
            value={draft.languages}
            placeholder="chi、eng"
            onChange={(e) => set('languages', e.target.value)}
          />
          {errors.languages ? <em className="me-err">{errors.languages}</em> : null}
        </label>

        <div className="form-row">
          <span>评分（0–5 星）</span>
          <StarRating
            value={draft.rating}
            onChange={(v) => set('rating', v)}
          />
        </div>

        <label className="form-row me-full">
          <span>标签（逗号或顿号分隔）</span>
          <input
            className="input"
            value={draft.tags}
            placeholder="古典文学, 长篇小说"
            onChange={(e) => set('tags', e.target.value)}
          />
        </label>

        <label className="form-row me-full">
          <span>简介</span>
          <textarea
            className="textarea"
            value={draft.comments}
            placeholder="没有就留空"
            onChange={(e) => set('comments', e.target.value)}
          />
        </label>

        <div className="me-full me-readonly">
          <div className="me-readonly-head">
            标识符
            <span className="me-note">只读 · 写库接口暂时改不了 ISBN / ASIN</span>
          </div>
          {ids.length === 0 ? (
            <span className="me-note">这本书还没有 ISBN / ASIN。</span>
          ) : (
            <div className="me-ids">
              {ids.map(([key, value]) => (
                <div className="me-id" key={key}>
                  <span className="me-id-k">{key}</span>
                  <code className="me-id-v">{value}</code>
                  <CopyText value={value} label={`${key.toUpperCase()} ${value}`} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {saveError ? <div className="me-error-box">{saveError}</div> : null}

      <div className="form-actions">
        <button
          className="btn btn-primary"
          disabled={saving || calibreRunning}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button className="btn" disabled={saving} onClick={onCancel}>
          取消
        </button>
        <span className="me-note" style={{ alignSelf: 'center' }}>
          留空保存就是清空；系列序号只认数字。
        </span>
      </div>
    </div>
  )
}
