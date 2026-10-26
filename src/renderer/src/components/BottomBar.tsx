import { useMemo } from 'react'
import type { Book } from '../../../shared/types'
import { CH } from '../../../shared/ipc'
import { useApp } from '../app/context'
import { coverUrl } from '../lib/cover'
import { IconConvert, IconStop } from '../icons'
import { formatElapsed, pickActive, useNow, useTaskSnapshot } from './ConvertShared'

const COVER_STYLE: React.CSSProperties = {
  width: 38,
  height: 52,
  flex: 'none',
  borderRadius: 4,
  objectFit: 'cover',
  background: '#f0f0f0',
  boxShadow: 'var(--shadow-1)'
}

const TITLE_STYLE: React.CSSProperties = {
  fontSize: 14,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const SUB_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--t2)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

/**
 * 底部常驻条：借网易云播放条的三态。
 *  - 有转换任务：当前任务（封面 + 书名 + 进度 + 取消）
 *  - 没有任务但在读：最近在读那本 + 继续阅读
 *  - 全都空闲：低调显示书库统计
 */
export default function BottomBar(): React.ReactElement {
  const { books, stats, navigate, toast } = useApp()
  const snap = useTaskSnapshot()

  const converts = snap?.converts ?? []
  const active = pickActive(converts)
  const queued = converts.filter((job) => job.status === 'queued').length
  const now = useNow(converts.some((job) => job.status === 'running'))

  // 最近在读：posFrac 最大的那本，进度一样时取最近读过的
  const reading = useMemo<Book | null>(() => {
    let best: Book | null = null
    for (const book of books) {
      if (book.posFrac == null) continue
      const beat =
        !best ||
        book.posFrac > (best.posFrac ?? 0) ||
        (book.posFrac === best.posFrac && (book.readEpoch ?? 0) > (best.readEpoch ?? 0))
      if (beat) best = book
    }
    return best
  }, [books])

  const onCancel = (jobId: string): void => {
    window.api
      .invoke<{ ok: boolean; message?: string }>(CH.convertCancel, jobId)
      .then((res) => {
        if (!res.ok) toast(res.message ?? '取消失败', 'error')
      })
      .catch((e: unknown) => toast(`取消失败：${String(e)}`, 'error'))
  }

  // 一、转换中 / 排队中
  if (active) {
    const book = books.find((item) => item.id === active.bookId)
    return (
      <div className="bottombar">
        {book?.hasCover ? (
          <img style={COVER_STYLE} src={coverUrl(book.id)} alt="" draggable={false} />
        ) : (
          <div style={{ ...COVER_STYLE, display: 'grid', placeItems: 'center', color: '#b9b9b9' }}>
            <IconConvert width={16} height={16} />
          </div>
        )}

        <div style={{ width: 240, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={TITLE_STYLE} title={active.title}>
            {active.title}
          </span>
          <span style={SUB_STYLE} title={active.stage}>
            {active.from} → {active.to.toUpperCase()} · {active.stage || '准备中'}
          </span>
        </div>

        <div className="progress" style={{ flex: 1, maxWidth: 380 }}>
          <i style={{ width: `${active.percent}%` }} />
        </div>
        <span style={{ fontSize: 13, color: 'var(--accent)', width: 40, textAlign: 'right' }}>
          {active.percent}%
        </span>
        <span style={{ fontSize: 12, color: 'var(--t2)', width: 78 }}>
          {formatElapsed(active, now)}
        </span>

        <button className="btn btn-sm btn-ghost" onClick={() => onCancel(active.id)}>
          <IconStop width={13} height={13} />
          取消
        </button>

        {queued > 0 ? (
          <span style={{ fontSize: 12, color: 'var(--t2)' }}>另有 {queued} 个排队</span>
        ) : null}

        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => navigate({ name: 'convert' })}>
          <IconConvert width={15} height={15} />
          转换队列
        </button>
      </div>
    )
  }

  // 二、没有任务，但书库里有阅读进度
  if (reading) {
    const percent = Math.round((reading.posFrac ?? 0) * 100)
    return (
      <div className="bottombar">
        {reading.hasCover ? (
          <img style={COVER_STYLE} src={coverUrl(reading.id)} alt="" draggable={false} />
        ) : (
          <div style={{ ...COVER_STYLE, display: 'grid', placeItems: 'center', color: '#b9b9b9' }}>
            <IconConvert width={16} height={16} />
          </div>
        )}

        <div style={{ width: 260, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={TITLE_STYLE} title={reading.title}>
            {reading.title}
          </span>
          <span style={SUB_STYLE}>
            {reading.authors || '佚名'} · 已读 {percent}%
          </span>
        </div>

        <div className="progress" style={{ flex: 1, maxWidth: 380 }}>
          <i style={{ width: `${percent}%` }} />
        </div>

        <button
          className="btn btn-sm btn-primary"
          onClick={() => navigate({ name: 'book', id: reading.id })}
        >
          继续阅读
        </button>

        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={() => navigate({ name: 'library' })}>
          书库
        </button>
      </div>
    )
  }

  // 三、全空闲：把常驻条压到最低调
  const pending = Math.max(0, stats.total - stats.withDesc)
  return (
    <div className="bottombar">
      <span style={{ fontSize: 13, color: 'var(--t2)' }}>
        书库 {stats.total} 本 · {stats.authors} 位作者 · {stats.series} 个系列 · EPUB {stats.epub} 本
        {pending > 0 ? ` · 待整理 ${pending} 本` : ''}
      </span>
      <span className="spacer" />
      <button className="btn btn-sm btn-ghost" onClick={() => navigate({ name: 'convert' })}>
        去转换
      </button>
      <button className="btn btn-sm btn-ghost" onClick={() => navigate({ name: 'workbench' })}>
        整理台
      </button>
    </div>
  )
}
