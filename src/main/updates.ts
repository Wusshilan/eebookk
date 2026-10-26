import { app, net } from 'electron'
import type { UpdateInfo } from '../shared/types'
import { ctx } from './ctx'

let cached: UpdateInfo | null = null

/** 简单 semver 比较，只认 1.2.3 这种 */
function isNewer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const b = current.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * 检查新版本。没配 endpoint、断网、返回格式不对，一律返回 hasUpdate=false，
 * 侧栏那颗「更新」角标也就不会出现 —— 角标只在真有新版时显示。
 */
export async function checkForUpdates(force = false): Promise<UpdateInfo> {
  const current = app.getVersion()
  const base: UpdateInfo = {
    hasUpdate: false,
    current,
    latest: null,
    url: null,
    notes: null,
    checkedAt: Date.now()
  }

  if (!force && cached && Date.now() - cached.checkedAt < 10 * 60 * 1000) return cached

  const endpoint = ctx.settings?.get().update.endpoint?.trim()
  const verbose = process.argv.some((a) => a.startsWith('--shot='))
  if (verbose) console.log(`[update] current=${current} endpoint=${endpoint || '(空)'}`)
  if (!endpoint) {
    cached = { ...base, message: '未配置更新源' }
    return cached
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await net.fetch(endpoint, { signal: controller.signal })
    if (!res.ok) {
      cached = { ...base, message: `更新源返回 ${res.status}` }
      return cached
    }
    const json = (await res.json()) as { version?: string; url?: string; notes?: string }
    const latest = json.version?.trim()
    if (!latest) {
      cached = { ...base, message: '更新源格式不正确' }
      return cached
    }
    cached = {
      ...base,
      hasUpdate: isNewer(latest, current),
      latest,
      url: json.url ?? null,
      notes: json.notes ?? null
    }
    return cached
  } catch (e) {
    const err = e as { name?: string; message?: string }
    cached = { ...base, message: err.name === 'AbortError' ? '检查更新超时' : (err.message ?? '检查失败') }
    return cached
  } finally {
    clearTimeout(timer)
  }
}

export function lastUpdateInfo(): UpdateInfo | null {
  return cached
}
