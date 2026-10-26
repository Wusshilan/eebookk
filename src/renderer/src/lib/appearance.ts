import type { AppearanceSettings } from '../../../shared/types'

/**
 * 把外观设置落到 :root 的 CSS 变量上。
 * App 启动时调一次；设置页每次保存后再调一次，做到即时生效。
 */
export function applyAppearance(a?: Partial<AppearanceSettings> | null): void {
  const root = document.documentElement
  const raw = Number(a?.coverRadius ?? 6)
  const radius = Number.isFinite(raw) ? Math.max(0, Math.min(16, Math.round(raw))) : 6
  root.style.setProperty('--radius-card', `${radius}px`)
  root.classList.toggle('density-compact', a?.gridDensity === 'compact')
}
