import type { ShortcutSettings } from '../../../shared/types'

/** 把按键事件拼成 'Ctrl+Shift+K' 这种规范字符串 */
export function comboOf(e: KeyboardEvent | React.KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key = e.key
  if (key.length === 1) key = key.toUpperCase()
  else if (key === ' ') key = 'Space'
  else if (key === ',') key = ','
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) parts.push(key)
  return parts.join('+')
}

/** 用户按下的组合是否命中某个快捷键 */
export function matches(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false
  return comboOf(e) === combo
}

/** 只带修饰键的功能键，避免在输入框里误触发 */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export const SHORTCUT_LABELS: { key: keyof ShortcutSettings; label: string }[] = [
  { key: 'search', label: '搜索' },
  { key: 'home', label: '首页' },
  { key: 'library', label: '书库' },
  { key: 'workbench', label: '整理台' },
  { key: 'convert', label: '转换' },
  { key: 'device', label: '设备' },
  { key: 'settings', label: '设置' },
  { key: 'theme', label: '切换深浅色' }
]
