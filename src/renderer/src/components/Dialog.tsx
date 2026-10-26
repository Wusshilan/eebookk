import { useEffect, useRef, useState } from 'react'

export interface DialogRequest {
  kind: 'confirm' | 'prompt'
  title: string
  message?: string
  label?: string
  defaultValue?: string
  placeholder?: string
  okText?: string
  cancelText?: string
  danger?: boolean
  resolve: (value: string | boolean | null) => void
}

/**
 * 应用内确认 / 输入框，替代 Electron 里的 window.confirm / window.prompt。
 * 原生对话框是系统样式，跟自绘无边框窗口完全两个世界，而且 prompt 会阻塞渲染进程。
 */
export default function Dialog({ req, onDone }: { req: DialogRequest; onDone: () => void }): React.ReactElement {
  const [value, setValue] = useState(req.defaultValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (req.kind === 'prompt') {
      const t = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 30)
      return () => clearTimeout(t)
    }
  }, [req])

  const cancel = (): void => {
    req.resolve(req.kind === 'prompt' ? null : false)
    onDone()
  }

  const ok = (): void => {
    req.resolve(req.kind === 'prompt' ? value : true)
    onDone()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      cancel()
    } else if (e.key === 'Enter' && (req.kind === 'confirm' || e.target === inputRef.current)) {
      e.preventDefault()
      ok()
    }
  }

  return (
    <div className="dlg-mask" onMouseDown={(e) => e.target === e.currentTarget && cancel()} onKeyDown={onKeyDown}>
      <div className="dlg" role="dialog" aria-modal="true" aria-label={req.title}>
        <h3 className="dlg-title">{req.title}</h3>
        {req.message ? <p className="dlg-msg">{req.message}</p> : null}
        {req.kind === 'prompt' ? (
          <>
            {req.label ? <div className="dlg-label">{req.label}</div> : null}
            <input
              ref={inputRef}
              className="input dlg-input"
              value={value}
              placeholder={req.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </>
        ) : null}
        <div className="dlg-actions">
          <button className="btn" onClick={cancel}>
            {req.cancelText ?? '取消'}
          </button>
          <button
            className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={req.kind === 'prompt' && !value.trim()}
            onClick={ok}
          >
            {req.okText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
