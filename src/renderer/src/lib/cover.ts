/** 封面统一走自定义协议，避免主进程传 base64 */
export function coverUrl(id: number | undefined | null): string {
  return id ? `bookcover://cover/${id}` : ''
}

export function formatBytes(n: number): string {
  if (!n) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return '—'
  // calibre 里没有出版日期时会写成 0101-01-01，别显示成真日期
  if (d.getFullYear() < 1000) return '未知'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** calibre 的 comments 是 HTML，列表里要纯文本 */
export function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 纯文本写回 calibre 时转成简单 HTML 段落 */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const paras = escaped
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
  return paras.join('\n')
}
