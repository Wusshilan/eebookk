import type { AppearanceSettings } from '../../../shared/types'

const ACCENTS: Record<string, { main: string; press: string; rgb: string }> = {
  green: { main: '#07c160', press: '#06ab56', rgb: '7, 193, 96' },
  blue: { main: '#1e80ff', press: '#1a72e6', rgb: '30, 128, 255' },
  purple: { main: '#7c5cff', press: '#6f4ef0', rgb: '124, 92, 255' },
  orange: { main: '#ff7a45', press: '#e86a37', rgb: '255, 122, 69' },
  rose: { main: '#f43f5e', press: '#db3552', rgb: '244, 63, 94' }
}

function resolvedTheme(theme: string | undefined): 'light' | 'dark' {
  if (theme === 'dark') return 'dark'
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

/**
 * 把外观设置落到 :root 的 CSS 变量上。
 * App 启动时调一次；设置页每次改动后再调一次，做到即时生效。
 */
export function applyAppearance(a?: Partial<AppearanceSettings> | null): void {
  const root = document.documentElement
  const style = root.style

  const radius = Number(a?.coverRadius ?? 6)
  style.setProperty('--radius-card', `${Number.isFinite(radius) ? Math.max(0, Math.min(40, Math.round(radius))) : 6}px`)

  const gridMin = Number(a?.gridMin ?? 140)
  style.setProperty('--grid-min', `${Number.isFinite(gridMin) ? Math.max(100, Math.min(220, Math.round(gridMin))) : 140}px`)

  const side = Number(a?.sidebarWidth ?? 306)
  style.setProperty('--sidebar-w', `${Number.isFinite(side) ? Math.max(220, Math.min(380, Math.round(side))) : 306}px`)

  style.setProperty('--smooth', a?.cornerStyle === 'round' ? 'round' : 'squircle')

  const accent = ACCENTS[a?.accent ?? 'green'] ?? ACCENTS.green
  style.setProperty('--accent', accent.main)
  style.setProperty('--accent-press', accent.press)
  style.setProperty('--accent-rgb', accent.rgb)
  style.setProperty('--accent-weak', `rgba(${accent.rgb}, 0.14)`)
  style.setProperty('--accent-shadow', `0 0 12px 1px rgba(${accent.rgb}, 0.18)`)

  root.dataset.theme = resolvedTheme(a?.theme)
}

/** 跟随系统时需要监听系统主题变化 */
export function watchSystemTheme(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
