import { useCallback, useEffect, useRef, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { EebookkApi } from '../../../preload/index'
import type { WebMetaHit } from '../../../shared/types'

const CW = 300
const CHh = 450
const OUT_W = 900
const OUT_H = 1350

interface Props {
  bookId: number
  /** 用来全网找封面的关键词 */
  title: string
  onClose: () => void
  onSaved: (message: string) => void
  invoke: EebookkApi['invoke']
  hasCover: boolean
  calibreRunning: boolean
}

/* 封面编辑器的样式统一写在 styles.css 的「封面编辑器」段里 */

export default function CoverEditor({
  bookId,
  title,
  onClose,
  onSaved,
  invoke,
  hasCover,
  calibreRunning
}: Props): React.ReactElement {
  const [src, setSrc] = useState<string | null>(null)
  const [nat, setNat] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [webHits, setWebHits] = useState<WebMetaHit[]>([])
  const [webLoading, setWebLoading] = useState(false)
  const [webError, setWebError] = useState('')
  const imgRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)

  const baseScale = nat.w > 0 ? Math.max(CW / nat.w, CHh / nat.h) : 1
  const scale = baseScale * zoom

  /** 全网找封面：返回的每一项都带真实像素，按面积从大到小 */
  const searchCovers = async (): Promise<void> => {
    if (!title.trim()) {
      setWebError('这本书没有书名')
      return
    }
    setWebLoading(true)
    setWebError('')
    try {
      const list = await invoke<WebMetaHit[]>(CH.coverSearch, title.trim())
      const arr = Array.isArray(list) ? list : []
      setWebHits(arr)
      if (arr.length === 0) setWebError('没找到封面')
    } catch (e) {
      setWebError(String(e))
    } finally {
      setWebLoading(false)
    }
  }

  /** 选中一个网络封面直接写进 calibre */
  const applyRemote = async (url: string): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const res = await invoke<{ ok: boolean; message: string }>(CH.coverApplyUrl, bookId, url)
      if (!res.ok) {
        setErr(res.message || '写封面失败')
        return
      }
      onSaved(res.message)
      onClose()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const clamp = useCallback(
    (x: number, y: number, s: number): { x: number; y: number } => {
      const w = nat.w * s
      const h = nat.h * s
      const minX = Math.min(0, CW - w)
      const minY = Math.min(0, CHh - h)
      return { x: Math.max(minX, Math.min(0, x)), y: Math.max(minY, Math.min(0, y)) }
    },
    [nat.w, nat.h]
  )

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 载入当前封面：走 IPC 拿 data URL，绕开自定义协议的 CORS 限制
  useEffect(() => {
    let alive = true
    if (!hasCover) {
      setSrc(null)
      return
    }
    invoke<{ ok: boolean; dataUrl?: string }>(CH.coverRead, bookId)
      .then((r) => {
        if (alive) setSrc(r.ok && r.dataUrl ? r.dataUrl : null)
      })
      .catch(() => {
        if (alive) setSrc(null)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, hasCover])

  // 图片尺寸就绪后居中
  useEffect(() => {
    if (!nat.w) return
    const s = Math.max(CW / nat.w, CHh / nat.h) * zoom
    setOff(clamp((CW - nat.w * s) / 2, (CHh - nat.h * s) / 2, s))
    // zoom 变化时保持居中即可，拖动由用户接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nat.w, nat.h])

  const onImgLoad = (): void => {
    const el = imgRef.current
    if (!el) return
    setNat({ w: el.naturalWidth, h: el.naturalHeight })
    setZoom(1)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!src) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = { px: e.clientX, py: e.clientY, ox: off.x, oy: off.y }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    setOff(clamp(d.ox + (e.clientX - d.px), d.oy + (e.clientY - d.py), scale))
  }

  const onPointerUp = (): void => {
    dragRef.current = null
    setDragging(false)
  }

  const onZoom = (z: number): void => {
    const prev = scale
    const next = baseScale * z
    // 以画面中心为锚点缩放
    const cx = (CW / 2 - off.x) / prev
    const cy = (CHh / 2 - off.y) / prev
    setZoom(z)
    setOff(clamp(CW / 2 - cx * next, CHh / 2 - cy * next, next))
  }

  const pick = async (): Promise<void> => {
    setErr(null)
    const r = await invoke<{ ok: boolean; dataUrl?: string; message?: string }>(CH.coverPick)
    if (r.ok && r.dataUrl) {
      setSrc(r.dataUrl)
      setNat({ w: 0, h: 0 })
      setZoom(1)
    } else if (r.message && r.message !== '已取消') {
      setErr(r.message)
    }
  }

  const save = async (): Promise<void> => {
    const el = imgRef.current
    if (!el || !nat.w) return
    setBusy(true)
    setErr(null)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = OUT_W
      canvas.height = OUT_H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建画布')
      ctx.imageSmoothingQuality = 'high'
      const sx = -off.x / scale
      const sy = -off.y / scale
      const sw = CW / scale
      const sh = CHh / scale
      ctx.drawImage(el, sx, sy, sw, sh, 0, 0, OUT_W, OUT_H)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
      const res = await invoke<{ ok: boolean; message: string }>(CH.coverApply, bookId, dataUrl)
      if (res.ok) {
        onSaved(res.message || '封面已更新')
        onClose()
      } else {
        setErr(res.message)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const res = await invoke<{ ok: boolean; message: string }>(CH.coverRemove, bookId)
      if (res.ok) {
        onSaved(res.message || '封面已移除')
        onClose()
      } else {
        setErr(res.message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ce-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ce-modal">
        <div className="ce-head">
          <h3 className="ce-title">封面</h3>
          <span className="ce-sub">拖拽移动 · 滚轮或滑块缩放 · 输出 900×1350</span>
          <span className="spacer" style={{ flex: 1 }} />
          <span className="ce-sub ce-ratio">{(zoom * 100).toFixed(0)}%</span>
        </div>

        <div className="ce-body">
          <div
            className={`ce-frame${dragging ? ' is-drag' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={(e) => {
              if (!nat.w) return
              e.preventDefault()
              onZoom(Math.max(1, Math.min(4, zoom - e.deltaY * 0.0015)))
            }}
          >
            {src ? (
              <>
                <img
                  ref={imgRef}
                  src={src}
                  alt=""
                  onLoad={onImgLoad}
                  style={{
                    width: nat.w * scale,
                    height: nat.h * scale,
                    transform: `translate(${off.x}px, ${off.y}px)`
                  }}
                />
                <div className="ce-grid">
                  <i style={{ left: '33.33%', top: 0, width: 1, height: '100%' }} />
                  <i style={{ left: '66.66%', top: 0, width: 1, height: '100%' }} />
                  <i style={{ top: '33.33%', left: 0, height: 1, width: '100%' }} />
                  <i style={{ top: '66.66%', left: 0, height: 1, width: '100%' }} />
                </div>
              </>
            ) : (
              <div className="ce-empty">
                这本书还没有封面
                <br />
                点右侧「选择图片」
              </div>
            )}
          </div>

          <div className="ce-side">
            <div className="ce-row">
              <span style={{ width: 40 }}>缩放</span>
              <input
                className="ce-range"
                type="range"
                min={100}
                max={400}
                value={Math.round(zoom * 100)}
                disabled={!nat.w}
                onChange={(e) => onZoom(Number(e.target.value) / 100)}
              />
            </div>

            {calibreRunning ? (
              <div className="warn-box">calibre 正在运行，保存会被拒绝。请先关闭 calibre。</div>
            ) : null}
            {err ? <div className="warn-box">{err}</div> : null}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => void pick()}>
                选择图片
              </button>
              {hasCover ? (
                <button className="btn btn-danger" disabled={busy || calibreRunning} onClick={() => void remove()}>
                  移除封面
                </button>
              ) : null}
            </div>
            <div className="ce-web">
              <button className="btn" disabled={webLoading} onClick={() => void searchCovers()}>
                {webLoading ? '查找中…' : '全网找封面'}
              </button>
              {webError ? <span className="ce-sub">{webError}</span> : null}
            </div>
            {webHits.length > 0 ? (
              <div className="ce-web-grid">
                {webHits.map((h) => (
                  <button
                    key={`${h.source}-${h.id}`}
                    type="button"
                    className="ce-web-item"
                    disabled={busy || calibreRunning}
                    title={`${h.sourceName}：${h.coverWidth}x${h.coverHeight}`}
                    onClick={() => {
                      if (h.coverUrl) void applyRemote(h.coverUrl)
                    }}
                  >
                    <img src={h.coverUrl ?? ''} alt="" />
                    <span className="ce-web-res">
                      {h.coverWidth}x{h.coverHeight}
                    </span>
                    <span className="ce-web-src">{h.sourceName}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="ce-foot">
          <span className="ce-sub">
            {nat.w ? `原图 ${nat.w}×${nat.h}` : '未加载图片'}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={!nat.w || busy || calibreRunning}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存封面'}
          </button>
        </div>
      </div>
    </div>
  )
}
