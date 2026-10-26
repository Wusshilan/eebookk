import { useEffect, useRef, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { ConvertJob, JobStatus, TaskSnapshot } from '../../../shared/types'

/** 目标格式：与主进程 src/main/convert.ts 的 TARGETS 保持一致 */
export const TARGETS = ['epub', 'mobi', 'azw3', 'pdf', 'txt'] as const
export type TargetFormat = (typeof TARGETS)[number]

export const TARGET_LABEL: Record<string, string> = {
  epub: 'EPUB',
  mobi: 'MOBI',
  azw3: 'AZW3',
  pdf: 'PDF',
  txt: 'TXT'
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排队中',
  running: '转换中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消'
}

export const STATUS_COLOR: Record<JobStatus, string> = {
  queued: '#848383',
  running: 'var(--accent)',
  done: '#0f9d58',
  failed: 'var(--badge)',
  canceled: '#a5a5a5'
}

/** 把主进程给的列表兼容成快照：正常是 TaskSnapshot，万一是裸数组也能接 */
export function normalizeSnapshot(raw: unknown): TaskSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  if (Array.isArray(raw)) return { converts: raw as ConvertJob[] }
  const converts = (raw as { converts?: unknown }).converts
  return { ...(raw as TaskSnapshot), converts: Array.isArray(converts) ? (converts as ConvertJob[]) : [] }
}

/**
 * 订阅转换队列：先拉一次当前快照，再听 evt:tasks 增量。
 * 若事件先到，就不让稍后返回的列表把新状态盖回去。
 */
export function useTaskSnapshot(): TaskSnapshot | null {
  const [snap, setSnap] = useState<TaskSnapshot | null>(null)
  const eventSeen = useRef(false)

  useEffect(() => {
    let alive = true
    window.api
      .invoke<TaskSnapshot | ConvertJob[]>(CH.convertList)
      .then((raw) => {
        if (!alive || eventSeen.current) return
        const next = normalizeSnapshot(raw)
        if (next) setSnap(next)
      })
      .catch(() => {
        /* 主进程队列还没起来时忽略，事件会补上 */
      })

    const off = window.api.on(CH.evtTasks, (raw) => {
      const next = normalizeSnapshot(raw)
      if (!next) return
      eventSeen.current = true
      setSnap(next)
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  return snap
}

/** 任务在跑时每秒刷新一次，用来算耗时 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function formatElapsed(job: ConvertJob, now: number): string {
  const start = job.startedAt ?? job.createdAt
  const end = job.finishedAt ?? now
  const sec = Math.max(0, Math.round((end - start) / 1000))
  if (sec < 60) return `${sec} 秒`
  const rest = sec % 60
  return `${Math.floor(sec / 60)} 分 ${String(rest).padStart(2, '0')} 秒`
}

/** 底部条要展示的那个任务：优先正在跑的，其次排队第一个 */
export function pickActive(converts: ConvertJob[]): ConvertJob | null {
  return (
    converts.find((job) => job.status === 'running') ??
    converts.find((job) => job.status === 'queued') ??
    null
  )
}
