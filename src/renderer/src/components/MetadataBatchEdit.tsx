import { useMemo, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { EditResult, MetadataPatch, QualityIssue } from '../../../shared/types'
import { useApp } from '../app/context'
import {
  METADATA_CSS, StarRating, badLanguage, cleanError, isValidDateInput, splitLanguages, splitTags
} from './MetadataFields'

type Mode = 'keep' | 'set' | 'clear'
type TagMode = 'keep' | 'add' | 'remove'
type ApplyResult = EditResult & { message?: string }

interface BatchResult {
  updated: number
  failed: EditResult['failed']
  message?: string
}

function ModeSelect({
  value,
  onChange,
  setLabel = '设置',
  clearLabel = '清空'
}: {
  value: Mode
  onChange: (v: Mode) => void
  setLabel?: string
  clearLabel?: string
}): React.ReactElement {
  return (
    <select className="select me-mode" value={value} onChange={(e) => onChange(e.target.value as Mode)}>
      <option value="keep">不改</option>
      <option value="set">{setLabel}</option>
      <option value="clear">{clearLabel}</option>
    </select>
  )
}

/**
 * 整理台的批量编辑：先勾一批书，再挑几个字段一次写完。
 * 标签的加/删依赖每本书原来的标签，所以按「写入后相同的标签」分组提交。
 */
export default function MetadataBatchEdit({
  issues,
  onApplied
}: {
  issues?: QualityIssue[]
  onApplied?: () => void
}): React.ReactElement {
  const {
    books, selected, setSelected, toggleSelected, clearSelection,
    calibreRunning, reload, toast
  } = useApp()

  const [search, setSearch] = useState('')
  const [seriesMode, setSeriesMode] = useState<Mode>('keep')
  const [seriesValue, setSeriesValue] = useState('')
  const [seriesIndexMode, setSeriesIndexMode] = useState<Mode>('keep')
  const [seriesIndexValue, setSeriesIndexValue] = useState('')
  const [publisherMode, setPublisherMode] = useState<Mode>('keep')
  const [publisherValue, setPublisherValue] = useState('')
  const [pubdateMode, setPubdateMode] = useState<Mode>('keep')
  const [pubdateValue, setPubdateValue] = useState('')
  const [languagesMode, setLanguagesMode] = useState<Mode>('keep')
  const [languagesValue, setLanguagesValue] = useState('')
  const [ratingMode, setRatingMode] = useState<Mode>('keep')
  const [ratingValue, setRatingValue] = useState<number | null>(null)
  const [tagMode, setTagMode] = useState<TagMode>('keep')
  const [tagValue, setTagValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [result, setResult] = useState<BatchResult | null>(null)

  const selectedBooks = useMemo(
    () => books.filter((b) => selected.includes(b.id)),
    [books, selected]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return books
    return books.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        b.authors.toLowerCase().includes(q) ||
        b.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [books, search])

  const shown = filtered.slice(0, 60)

  const hasChanges =
    seriesMode !== 'keep' ||
    seriesIndexMode !== 'keep' ||
    publisherMode !== 'keep' ||
    pubdateMode !== 'keep' ||
    languagesMode !== 'keep' ||
    ratingMode !== 'keep' ||
    tagMode !== 'keep'

  const resetFields = (): void => {
    setSeriesMode('keep')
    setSeriesValue('')
    setSeriesIndexMode('keep')
    setSeriesIndexValue('')
    setPublisherMode('keep')
    setPublisherValue('')
    setPubdateMode('keep')
    setPubdateValue('')
    setLanguagesMode('keep')
    setLanguagesValue('')
    setRatingMode('keep')
    setRatingValue(null)
    setTagMode('keep')
    setTagValue('')
    setFormError('')
    setResult(null)
  }

  const buildCommon = (): { patch: MetadataPatch; error: string } => {
    const patch: MetadataPatch = {}

    if (seriesMode === 'set') {
      const v = seriesValue.trim()
      if (!v) return { patch, error: '系列是空的。想清空，把左边切成「清空」。' }
      patch.series = v
    } else if (seriesMode === 'clear') {
      patch.series = null
      // 系列没了，序号留着没意义；除非用户下面单独指定序号
      if (seriesIndexMode === 'keep') patch.seriesIndex = null
    }

    if (seriesIndexMode === 'set') {
      if (seriesMode === 'clear') return { patch, error: '系列已经清空，序号就不用填了。' }
      const v = seriesIndexValue.trim()
      if (!/^\d+(\.\d+)?$/.test(v)) return { patch, error: '系列序号填数字，可以带小数。' }
      patch.seriesIndex = Number(v)
    } else if (seriesIndexMode === 'clear') {
      patch.seriesIndex = null
    }

    if (publisherMode === 'set') {
      const v = publisherValue.trim()
      if (!v) return { patch, error: '出版社是空的。想清空就选「清空」。' }
      patch.publisher = v
    } else if (publisherMode === 'clear') {
      patch.publisher = null
    }

    if (pubdateMode === 'set') {
      const v = pubdateValue.trim()
      if (!v) return { patch, error: '出版日期是空的。想清空就选「清空」。' }
      if (!isValidDateInput(v)) return { patch, error: '出版日期按 yyyy-mm-dd 填，比如 2008-05-01。' }
      patch.pubdate = v
    } else if (pubdateMode === 'clear') {
      patch.pubdate = null
    }

    if (languagesMode === 'set') {
      const v = languagesValue.trim()
      if (!v) return { patch, error: '语言是空的。想清空就选「清空」。' }
      const bad = badLanguage(v)
      if (bad) return { patch, error: `「${bad}」不像语言码，用 chi、zh、eng 这种。` }
      patch.languages = splitLanguages(v)
    } else if (languagesMode === 'clear') {
      patch.languages = []
    }

    if (ratingMode === 'set') {
      if (ratingValue == null) return { patch, error: '评分还没点星星。' }
      patch.rating = ratingValue * 2
    } else if (ratingMode === 'clear') {
      patch.rating = null
    }

    return { patch, error: '' }
  }

  const submit = async (): Promise<void> => {
    setFormError('')
    setResult(null)
    if (calibreRunning) {
      setFormError('calibre 正在运行，写不进去。关掉 calibre 再试。')
      return
    }
    if (!selectedBooks.length) {
      setFormError('先勾选要改的书。')
      return
    }
    if (!hasChanges) {
      setFormError('所有字段都是「不改」，没有要写的东西。')
      return
    }
    const built = buildCommon()
    if (built.error) {
      setFormError(built.error)
      return
    }

    let tagList: string[] = []
    if (tagMode !== 'keep') {
      tagList = splitTags(tagValue)
      if (!tagList.length) {
        setFormError(tagMode === 'add' ? '要加的标签是空的。' : '要删的标签是空的。')
        return
      }
    }

    setBusy(true)
    try {
      let updated = 0
      const failed: EditResult['failed'] = []
      let message = ''
      const base = built.patch

      if (tagMode === 'keep') {
        const res = await window.api.invoke<ApplyResult>(
          CH.metadataApply,
          selectedBooks.map((b) => b.id),
          base
        )
        updated += res.updated
        failed.push(...res.failed)
        message = res.message ?? ''
      } else {
        // 同一次写入里每本书的标签可能不同，按结果标签分组，一组只调一次 calibredb
        const groups = new Map<string, { ids: number[]; tags: string[] }>()
        for (const b of selectedBooks) {
          const next =
            tagMode === 'add'
              ? [...b.tags, ...tagList.filter((t) => !b.tags.includes(t))]
              : b.tags.filter((t) => !tagList.includes(t))
          const deduped: string[] = []
          for (const t of next) if (t && !deduped.includes(t)) deduped.push(t)
          const unchanged =
            deduped.length === b.tags.length && deduped.every((t, i) => t === b.tags[i])
          if (unchanged) continue
          const key = deduped.join('\u001f')
          const group = groups.get(key)
          if (group) group.ids.push(b.id)
          else groups.set(key, { ids: [b.id], tags: deduped })
        }

        if (groups.size === 0) {
          setResult({ updated: 0, failed: [], message: '没有需要改的' })
        } else {
          for (const group of groups.values()) {
            const res = await window.api.invoke<ApplyResult>(
              CH.metadataApply,
              group.ids,
              { ...base, tags: group.tags }
            )
            updated += res.updated
            failed.push(...res.failed)
            if (res.message) {
              message = res.message
              break
            }
          }
        }
      }

      if (updated) {
        await reload()
        onApplied?.()
      }
      setResult({ updated, failed, message: message || undefined })
      if (!failed.length && !message && updated) {
        toast(`已更新 ${updated} 本`, 'success')
      }
    } catch (e) {
      setResult({
        updated: 0,
        failed: [],
        message: cleanError(e instanceof Error ? e.message : String(e))
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel me-batch">
      <style>{METADATA_CSS}</style>

      <div className="panel-head">
        <h3 className="panel-title">批量编辑</h3>

        <span className="spacer" />
        <span className="me-note">已选 {selectedBooks.length} 本</span>
        {calibreRunning ? <span className="lock-pill">calibre 运行中 · 不能写库</span> : null}
      </div>

      {calibreRunning ? (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          calibre 正在运行，书库被它锁着。关掉 calibre 再回来。
        </div>
      ) : null}

      <div className="me-picker">
        <input
          className="input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="me-picker-actions">
          <button
            className="btn btn-sm"
            disabled={!shown.length}
            onClick={() => setSelected([...new Set([...selected, ...shown.map((b) => b.id)])])}
          >
            加选这 {shown.length} 本
          </button>
          <button className="btn btn-sm" disabled={!selected.length} onClick={clearSelection}>
            清空选择
          </button>
          <span className="me-note">
            匹配 {filtered.length} 本
            
          </span>
        </div>
        <div className="me-picker-list">
          {shown.length === 0 ? (
            <div className="me-note me-picker-empty">没有匹配的书</div>
          ) : (
            shown.map((b) => (
              <label key={b.id} className={`me-book-row${selected.includes(b.id) ? ' is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(b.id)}
                  onChange={() => toggleSelected(b.id)}
                />
                <span className="me-book-title" title={b.title}>{b.title}</span>
                <span className="me-book-author">{b.authors || '佚名'}</span>
              </label>
            ))
          )}
        </div>
      </div>

      {issues && issues.some((i) => i.count > 0) ? (
        <div className="me-quick">
          <span className="me-note">按问题带入：</span>
          {issues
            .filter((i) => i.count > 0)
            .map((i) => (
              <button
                key={i.key}
                className="chip me-chip"

                onClick={() => setSelected(i.bookIds)}
              >
                {i.label} · {i.count}
              </button>
            ))}
        </div>
      ) : null}

      <div className="me-batch-grid">
        <div className="me-field">
          <span>系列</span>
          <div className="me-field-head">
            <ModeSelect value={seriesMode} onChange={setSeriesMode} />
            <input
              className="input"
              disabled={seriesMode !== 'set'}
              value={seriesValue}
              onChange={(e) => setSeriesValue(e.target.value)}
            />
          </div>
        </div>

        <div className="me-field">
          <span>系列序号</span>
          <div className="me-field-head">
            <ModeSelect value={seriesIndexMode} onChange={setSeriesIndexMode} />
            <input
              className="input"
              disabled={seriesIndexMode !== 'set'}
              value={seriesIndexValue}
              inputMode="decimal"
              onChange={(e) => setSeriesIndexValue(e.target.value)}
            />
          </div>
        </div>

        <div className="me-field">
          <span>出版社</span>
          <div className="me-field-head">
            <ModeSelect value={publisherMode} onChange={setPublisherMode} />
            <input
              className="input"
              disabled={publisherMode !== 'set'}
              value={publisherValue}
              onChange={(e) => setPublisherValue(e.target.value)}
            />
          </div>
        </div>

        <div className="me-field">
          <span>出版日期（yyyy-mm-dd）</span>
          <div className="me-field-head">
            <ModeSelect value={pubdateMode} onChange={setPubdateMode} />
            <input
              className="input"
              disabled={pubdateMode !== 'set'}
              value={pubdateValue}
              onChange={(e) => setPubdateValue(e.target.value)}
            />
          </div>
        </div>

        <div className="me-field">
          <span>语言（ISO 码，多个用逗号）</span>
          <div className="me-field-head">
            <ModeSelect value={languagesMode} onChange={setLanguagesMode} />
            <input
              className="input"
              disabled={languagesMode !== 'set'}
              value={languagesValue}
              onChange={(e) => setLanguagesValue(e.target.value)}
            />
          </div>
        </div>

        <div className="me-field">
          <span>评分（0–5 星）</span>
          <div className="me-field-head">
            <ModeSelect value={ratingMode} onChange={setRatingMode} />
            <StarRating
              value={ratingValue}
              onChange={setRatingValue}
              disabled={ratingMode !== 'set'}
              showClear={false}
            />
          </div>
        </div>

        <div className="me-field">
          <span>标签</span>
          <div className="me-field-head">
            <select
              className="select me-mode"
              value={tagMode}
              onChange={(e) => setTagMode(e.target.value as TagMode)}
            >
              <option value="keep">不改</option>
              <option value="add">加一组</option>
              <option value="remove">删一组</option>
            </select>
            <input
              className="input"
              disabled={tagMode === 'keep'}
              value={tagValue}
              onChange={(e) => setTagValue(e.target.value)}
            />
          </div>
        </div>
      </div>

      {formError ? <div className="me-error-box">{formError}</div> : null}

      {result ? (
        <div className={`me-result${result.failed.length || result.message ? ' is-bad' : ''}`}>
          {result.message ? <div>{cleanError(result.message)}</div> : null}
          {result.updated > 0 || result.failed.length > 0 ? (
            <div>
              已更新 {result.updated} 本
              {result.failed.length ? `，失败 ${result.failed.length} 本` : ''}
            </div>
          ) : null}
          {result.failed.slice(0, 3).map((f) => (
            <div className="me-result-fail" key={f.id}>
              《{f.title || `#${f.id}`}》{cleanError(f.error)}
            </div>
          ))}
          {result.failed.length > 3 ? (
            <div className="me-result-fail">另外 {result.failed.length - 3} 本失败，没列出来。</div>
          ) : null}
        </div>
      ) : null}

      <div className="form-actions" style={{ marginTop: 14 }}>
        <button
          className="btn btn-primary"
          disabled={busy || calibreRunning || !selectedBooks.length}
          onClick={() => void submit()}
        >
          {busy ? '写入中…' : `写入 ${selectedBooks.length} 本`}
        </button>
        <button className="btn" disabled={busy} onClick={resetFields}>
          重置字段
        </button>
        <span className="me-note" style={{ alignSelf: 'center' }}>
          只有标成「设置 / 清空 / 加 / 删」的字段会写；「不改」保持原样。
        </span>
      </div>
    </div>
  )
}
