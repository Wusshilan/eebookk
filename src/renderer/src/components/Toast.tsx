import { useCallback, useEffect, useState } from 'react'

export interface ToastItem {
  id: number
  msg: string
  kind: 'info' | 'success' | 'error'
}

export default function Toast({ items }: { items: ToastItem[] }): React.ReactElement {
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

/**
 * 供 App 使用的简易 toast 队列。
 * push 必须用 useCallback 固定引用：它会进 App 的 context useMemo 依赖，
 * 每次渲染都换新函数的话，整个应用会跟着无谓重渲染。
 */
export function useToasts(): [ToastItem[], (msg: string, kind?: ToastItem['kind']) => void] {
  const [items, setItems] = useState<ToastItem[]>([])

  const push = useCallback((msg: string, kind: ToastItem['kind'] = 'info') => {
    const id = Date.now() + Math.random()
    setItems((prev) => [...prev, { id, msg, kind }])
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 3200)
  }, [])

  return [items, push]
}

export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(active)
  useEffect(() => {
    if (active) {
      setOn(true)
      return
    }
    const t = setTimeout(() => setOn(false), ms)
    return () => clearTimeout(t)
  }, [active, ms])
  return on
}
