/**
 * 元数据编辑 / 批量编辑共用的小零件与样式。
 * 样式统一用 me- 前缀，只在本文件里维护一份。
 */
import { useApp } from '../app/context'

export const METADATA_CSS = `
.me-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px 20px;
}
.me-grid > .me-full { grid-column: 1 / -1; }
.me-err {
  color: #c0392b;
  font-size: 12px;
  font-style: normal;
  line-height: 1.5;
}
.me-error-box {
  margin-top: 2px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fdecec;
  color: #a5251c;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 190px;
  overflow: auto;
}
.me-note {
  font-size: 12px;
  color: var(--t2);
  line-height: 1.6;
}
.me-stars {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 34px;
}
.me-star {
  font-size: 22px;
  line-height: 1;
  color: #d8d8d8;
  padding: 0 2px;
  transition: color 0.12s;
}
.me-star.is-on { color: #e8a33d; }
.me-star:hover:not(:disabled) { color: #f0b85a; }
.me-star:disabled { cursor: default; }
.me-clear-btn {
  font-size: 12px;
  color: var(--t2);
  padding: 4px 8px;
  border-radius: 6px;
  margin-left: 4px;
}
.me-clear-btn:hover:not(:disabled) {
  color: var(--accent-press);
  background: var(--accent-weak);
}
.me-clear-btn:disabled { opacity: 0.45; cursor: default; }
.me-readonly {
  padding: 12px 14px;
  border: 1px dashed var(--hairline);
  border-radius: 10px;
  background: #fbfbfb;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.me-readonly-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--t2);
}
.me-ids { display: flex; flex-direction: column; gap: 6px; }
.me-id { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.me-id-k {
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--t2);
  text-transform: uppercase;
  min-width: 40px;
}
.me-id-v { font-size: 12.5px; color: #303030; word-break: break-all; }
.me-copy {
  font-size: 12px;
  color: var(--accent-press);
  padding: 2px 6px;
  border-radius: 5px;
}
.me-copy:hover { background: var(--accent-weak); }
.me-batch { margin-top: 8px; }
.me-batch-top {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.me-picker {
  border: 1px solid var(--hairline);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface-2);
}
.me-picker-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.me-picker-list {
  max-height: 190px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.me-book-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--t1);
}
.me-book-row:hover { background: var(--surface); }
.me-book-row.is-on { background: var(--accent-weak); }
.me-book-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.me-book-author {
  font-size: 11.5px;
  color: var(--t2);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.me-picker-empty { padding: 10px 6px; }
.me-quick {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 12px 0 4px;
}
.me-chip {
  cursor: pointer;
  border: 1px solid var(--hairline);
  background: var(--surface);
}
.me-chip:hover { border-color: var(--accent); color: var(--accent-press); }
.me-batch-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px 20px;
  margin-top: 14px;
}
.me-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--t2);
  min-width: 0;
}
.me-field-head { display: flex; align-items: center; gap: 8px; }
.me-mode {
  width: 92px;
  flex: none;
  height: 34px;
  padding: 0 8px;
}
.me-field .input { width: 100%; }
.me-result {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--accent-weak);
  color: #0d6b3b;
  font-size: 13px;
  line-height: 1.7;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.me-result.is-bad { background: #fff6e8; color: #9a6100; }
.me-result-fail { font-size: 12.5px; color: #a5251c; word-break: break-word; }
.me-result-fail .me-err { color: inherit; }
@media (max-width: 1100px) {
  .me-grid { grid-template-columns: minmax(0, 1fr); }
  .me-batch-grid { grid-template-columns: minmax(0, 1fr); }
}
`

/** 0–5 星输入；再点同一颗星取消。 */
export function StarRating({
  value,
  onChange,
  disabled,
  showClear = true
}: {
  value: number | null
  onChange: (v: number | null) => void
  disabled?: boolean
  showClear?: boolean
}): React.ReactElement {
  return (
    <div className="me-stars" role="group" aria-label="评分">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`me-star${value != null && n <= value ? ' is-on' : ''}`}
          disabled={disabled}
          aria-label={`${n} 星`}
          title={value === n ? '再点一次取消评分' : `${n} 星`}
          onClick={() => onChange(value === n ? null : n)}
        >
          ★
        </button>
      ))}
      {showClear ? (
        <button
          type="button"
          className="me-clear-btn"
          disabled={disabled || value == null}
          onClick={() => onChange(null)}
        >
          清除
        </button>
      ) : null}
    </div>
  )
}

/** 复制一个值；失败时退回到老办法，不让按钮点了没反应。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

export function CopyText({ value, label }: { value: string; label: string }): React.ReactElement {
  const { toast } = useApp()
  return (
    <button
      type="button"
      className="me-copy"
      title={`复制${label}`}
      onClick={() => {
        void copyToClipboard(value).then((ok) => {
          toast(ok ? `已复制${label}` : '复制失败，手动选中吧', ok ? 'success' : 'error')
        })
      }}
    >
      复制
    </button>
  )
}

/** 把 calibre 的 UTC 时间串取成 yyyy-mm-dd，交给日期输入框。0101-01-01 视为没有。 */
export function pubdateInput(raw: string | null | undefined): string {
  if (!raw) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (!m) return ''
  if (Number(m[1]) < 1000) return ''
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** yyyy-mm-dd，且必须是真实存在的一天 */
export function isValidDateInput(raw: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

/** 标签分隔符跟着 calibre 的习惯：英文逗号，也认中文逗号和顿号 */
export function splitTags(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,，、]/)) {
    const t = part.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** calibre 只认 ISO 639-1 两字母码和 639-2/T 三字母码；639-2/B 的旧码会被它静默丢掉 */
const LANGUAGE_ALIAS: Record<string, string> = {
  chi: 'zh',
  fre: 'fr',
  ger: 'de',
  dut: 'nl',
  cze: 'cs',
  gre: 'el',
  rum: 'ro',
  slo: 'sk',
  tib: 'bo',
  wel: 'cy',
  per: 'fa',
  alb: 'sq',
  arm: 'hy',
  geo: 'ka',
  ice: 'is',
  mao: 'mi',
  bur: 'my',
  may: 'ms',
  scr: 'hr',
  mac: 'mk',
  baq: 'eu'
}

export function splitLanguages(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,，\s]+/)) {
    const t = part.trim().toLowerCase()
    if (!t) continue
    const code = LANGUAGE_ALIAS[t] ?? t
    if (!out.includes(code)) out.push(code)
  }
  return out
}

/** 返回第一个不像 ISO 639 语言码的输入，都合法就返回 null */
export function badLanguage(raw: string): string | null {
  return splitLanguages(raw).find((s) => !/^[a-z]{2,3}$/.test(s)) ?? null
}

/** 主进程的 stderr 常以 Error: 开头，去掉这层壳再给人看 */
export function cleanError(raw: string | undefined | null): string {
  if (!raw) return '写入失败'
  const s = raw.replace(/^(Error:\s*)+/i, '').trim()
  return s || '写入失败'
}
