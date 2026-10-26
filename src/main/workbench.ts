import { execFile } from 'node:child_process'
import { ipcMain } from 'electron'
import { promisify } from 'node:util'
import { CH } from '../shared/ipc'
import type {
  EditResult, MetadataPatch, QualityIssue, QualityReport, TagStat
} from '../shared/types'
import { ctx } from './ctx'
import { calibreExe, isCalibreRunning } from './env'

const run = promisify(execFile)

/* ---------------- 标签判定 ---------------- */

/** 明确是盗版 / 搬运站的名字片段 */
const PIRACY = /(z-?lib|annas?\s*archive|sanqiu|sobooks|jiumodiary|周读|书栈|鸠摩|天浪|汇书|雅书|电子书分享|读书会)/i

/** 下载站会在标签里塞公众号、群号、引流话术 */
const WATERMARK = /(公众号|微信号|微信|qq\s*群|企鹅群|扫码|关注|分享更多|免费分享|更多好书|搜索雅书|资源分享)/i

/** 网址或文件格式被当成标签 */
const URLISH = /(www\.|https?:|\.com\b|\.net\b|\.org\b|\.cn\b|\.mobi\b|\.epub\b|\.azw3\b|\.txt\b|\.pdf\b)/i

/** 整个标签就是这类无意义词 */
const EXACT_JUNK = new Set([
  '书库', '书屋', '书店', '书城', '书吧', '电子书', '下载', '免费',
  '资源', '未分类', '其它', '其他', '未知', '无', '未知作者', '未分类书籍'
])

/**
 * 判断一个标签是不是下载站水印 / 垃圾标签，返回原因。
 * 注意：不要把「商务印书馆」「中华书局」这类出版社名误判进来 ——
 * 所以不用「馆/局/城/社/店」这种城市级后缀，只认明确的引流特征。
 */
export function suspiciousTag(name: string): string | null {
  const s = name.trim()
  if (!s) return '空标签'
  if (PIRACY.test(s)) return '疑似盗版源标记'
  if (WATERMARK.test(s)) return '疑似下载站引流'
  if (URLISH.test(s)) return '疑似网址或文件格式'
  if (EXACT_JUNK.has(s)) return '无意义的通用词'
  // 短站点名：含「书/文/读」且以 网/屋/阁 结尾，且不超过 6 字
  if (s.length <= 6 && /[书文读]/.test(s) && /(网|屋|阁)$/.test(s)) return '疑似站点名'
  if (/^[\d\s\-_.,;:!?+*/\\|]+$/.test(s)) return '纯符号 / 数字'
  if (s.length <= 2 && !/[\u4e00-\u9fa5]/.test(s)) return '过短且无意义'
  return null
}

/* ---------------- 质量报告 ---------------- */

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/[\s\-_:：·,，.。!！?？'"“”‘’《》<>]/g, '')
    .replace(/(全\d+[册卷]|套装|epub|mobi|azw3|pdf|txt)/g, '')
    .trim()
}

export function buildReport(): QualityReport {
  const lib = ctx.ensureLibrary()
  if (!lib) return { score: 0, total: 0, issues: [], tags: [] }
  const books = lib.all()
  const total = books.length || 1

  const missingDesc = books.filter((b) => b.descLen === 0)
  const missingTags = books.filter((b) => b.tags.length === 0)
  const missingCover = books.filter((b) => !b.hasCover)
  const missingId = books.filter((b) => Object.keys(b.identifiers).length === 0)
  const noEpub = books.filter((b) => !b.formats.includes('EPUB'))

  const tagsWithIssue = books.filter((b) => b.tags.some((t) => suspiciousTag(t)))

  const byTitle = new Map<string, number[]>()
  for (const b of books) {
    const k = normalizeTitle(b.title)
    if (!k) continue
    byTitle.set(k, [...(byTitle.get(k) ?? []), b.id])
  }
  const dupIds = [...byTitle.values()].filter((ids) => ids.length > 1).flat()

  const issues: QualityIssue[] = [
    {
      key: 'missing-desc',
      label: '缺简介',
      count: missingDesc.length,
      bookIds: missingDesc.map((b) => b.id),
      severity: 'high',
      hint: '没有简介，详情页几乎是空的。可以从豆瓣 / Google Books 抓取，或手动补。'
    },
    {
      key: 'suspicious-tags',
      label: '水印标签',
      count: tagsWithIssue.length,
      bookIds: tagsWithIssue.map((b) => b.id),
      severity: 'high',
      hint: '标签里混进了下载站名、网址或文件格式。一键清掉即可。'
    },
    {
      key: 'missing-tags',
      label: '缺标签',
      count: missingTags.length,
      bookIds: missingTags.map((b) => b.id),
      severity: 'medium',
      hint: '没有标签就无法按主题分组，标签浏览器里也看不到这些书。'
    },
    {
      key: 'missing-cover',
      label: '缺封面',
      count: missingCover.length,
      bookIds: missingCover.map((b) => b.id),
      severity: 'medium',
      hint: '没有封面的书在书架上显示为灰块。'
    },
    {
      key: 'missing-identifier',
      label: '无 ISBN / ASIN',
      count: missingId.length,
      bookIds: missingId.map((b) => b.id),
      severity: 'low',
      hint: '没有标识符，后续自动抓元数据和查重都会比较吃力。'
    },
    {
      key: 'duplicate-title',
      label: '疑似重复',
      count: dupIds.length,
      bookIds: dupIds,
      severity: 'medium',
      hint: '书名去掉标点和副标题后相同，可能是同一本书的多个版本。'
    },
    {
      key: 'no-epub',
      label: '没有 EPUB',
      count: noEpub.length,
      bookIds: noEpub.map((b) => b.id),
      severity: 'low',
      hint: '这些书只有其他格式，推送 Kindle 前需要先转换。'
    }
  ]

  // 标签统计
  const counter = new Map<string, number>()
  for (const b of books) for (const t of b.tags) counter.set(t, (counter.get(t) ?? 0) + 1)
  const tags: TagStat[] = [...counter.entries()]
    .map(([name, count]) => {
      const reason = suspiciousTag(name)
      return { name, count, suspicious: reason != null, reason: reason ?? undefined }
    })
    .sort((a, b) => Number(b.suspicious) - Number(a.suspicious) || b.count - a.count)

  // 健康度：各项按权重扣分
  const weights: Record<QualityIssue['key'], number> = {
    'missing-desc': 26,
    'suspicious-tags': 14,
    'missing-tags': 16,
    'missing-cover': 16,
    'missing-identifier': 8,
    'duplicate-title': 10,
    'no-epub': 6
  }
  let penalty = 0
  for (const issue of issues) penalty += (issue.count / total) * weights[issue.key]
  const score = Math.max(0, Math.round(100 - penalty))

  return { score, total: books.length, issues, tags }
}

/* ---------------- 写回 ---------------- */

async function guardWritable(): Promise<string | null> {
  ctx.calibreRunning = await isCalibreRunning()
  if (ctx.calibreRunning) {
    return 'calibre 正在运行，calibredb 会拒绝一切写入（包括只读命令）。请先关闭 calibre。'
  }
  if (!ctx.ensureLibrary()) return '书库未就绪'
  return null
}

function patchToArgs(patch: MetadataPatch): string[] {
  const args: string[] = []
  const meta = ctx.settings?.get().metadata
  const authorSep = meta?.authorSeparator?.trim() || ' & '
  const tagSep = meta?.tagSeparator?.trim() || ','
  const push = (field: string, value: string): void => {
    args.push('--field', `${field}:${value}`)
  }
  if (patch.title != null) push('title', patch.title)
  if (patch.authors != null) push('authors', patch.authors.join(authorSep))
  if (patch.series !== undefined) push('series', patch.series ?? '')
  if (patch.seriesIndex !== undefined) push('series_index', String(patch.seriesIndex ?? 1))
  if (patch.tags !== undefined) push('tags', (patch.tags ?? []).join(tagSep))
  if (patch.rating !== undefined) {
    // calibre 的 rating 字段是「0–5 星」，它自己会 ×2 存成 0–10；
    // 我们内部统一用 0–10，所以这里必须折半，否则 4 星会被写成满分。
    // 清空评分要用 0，发空值 calibredb 会直接报错（实测 exit=1）。
    const stars =
      patch.rating == null ? '0' : String(Math.max(0, Math.min(5, Math.round(patch.rating / 2))))
    push('rating', stars)
  }
  if (patch.comments !== undefined) push('comments', patch.comments ?? '')
  if (patch.publisher !== undefined) push('publisher', patch.publisher ?? '')
  if (patch.languages !== undefined) push('languages', (patch.languages ?? []).join(','))
  if (patch.pubdate !== undefined) {
    // 只给日期时 calibre 会按本地时区解释，实测会整体偏移一天；
    // 带上明确的 Z 才能得到用户选的那一天。空值表示清空（calibre 记成 0101-01-01）。
    const d = patch.pubdate?.trim()
    push('pubdate', d ? `${d}T00:00:00Z` : '')
  }
  return args
}

async function setMetadata(ids: number[], patch: MetadataPatch): Promise<EditResult> {
  const lib = ctx.ensureLibrary()
  const failed: EditResult['failed'] = []
  if (!lib) return { ok: false, updated: 0, failed }
  const fields = patchToArgs(patch)
  if (!fields.length) return { ok: true, updated: 0, failed }

  let updated = 0
  // 同一组字段可以一次调用写多本；失败再逐本重试以定位问题
  try {
    await run(
      calibreExe('calibredb'),
      ['set_metadata', ...ids.map(String), ...fields, '--with-library', lib.root],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    updated = ids.length
  } catch {
    for (const id of ids) {
      try {
        await run(
          calibreExe('calibredb'),
          ['set_metadata', String(id), ...fields, '--with-library', lib.root],
          { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
        )
        updated += 1
      } catch (e) {
        const err = e as { stderr?: string; message?: string }
        const book = lib.book(id)
        failed.push({ id, title: book?.title ?? String(id), error: err.stderr ?? err.message ?? '失败' })
      }
    }
  }
  if (updated && ctx.settings?.get().metadata.embedOnSave) {
    // 「设置 → 元数据 → 保存后嵌入文件」：把刚写的元数据也塞进书籍文件本身
    try {
      await run(
        calibreExe('calibredb'),
        ['embed_metadata', ...ids.map(String), '--with-library', lib.root],
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      )
    } catch {
      /* 嵌入失败不回滚元数据，只影响文件内嵌那一份 */
    }
  }
  if (updated) ctx.reload()
  return { ok: failed.length === 0, updated, failed }
}

/* ---------------- 注册 ---------------- */

export function registerWorkbench(): void {
  ipcMain.handle(CH.qualityReport, () => buildReport())

  ipcMain.handle(CH.metadataApply, async (_e, ids: number[], patch: MetadataPatch) => {
    const blocked = await guardWritable()
    if (blocked) return { ok: false, updated: 0, failed: [], message: blocked }
    return setMetadata(ids, patch)
  })

  /** 标签净化：删掉指定标签，或按映射重命名 */
  ipcMain.handle(
    CH.tagsCleanup,
    async (_e, op: { remove?: string[]; rename?: Record<string, string> }) => {
      const blocked = await guardWritable()
      if (blocked) return { ok: false, updated: 0, failed: [], message: blocked }
      const lib = ctx.ensureLibrary()
      if (!lib) return { ok: false, updated: 0, failed: [], message: '书库未就绪' }

      const removeSet = new Set(op.remove ?? [])
      const renameMap = op.rename ?? {}
      const touched: { id: number; tags: string[] }[] = []

      for (const book of lib.all()) {
        let changed = false
        const next: string[] = []
        for (const t of book.tags) {
          if (removeSet.has(t)) {
            changed = true
            continue
          }
          const mapped = renameMap[t]
          if (mapped) {
            changed = true
            if (mapped.trim() && !next.includes(mapped.trim())) next.push(mapped.trim())
            continue
          }
          if (!next.includes(t)) next.push(t)
        }
        if (changed) touched.push({ id: book.id, tags: next })
      }

      let updated = 0
      const failed: EditResult['failed'] = []
      for (const item of touched) {
        try {
          await run(
            calibreExe('calibredb'),
            ['set_metadata', String(item.id), '--field', `tags:${item.tags.join(',')}`, '--with-library', lib.root],
            { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
          )
          updated += 1
        } catch (e) {
          const err = e as { stderr?: string; message?: string }
          failed.push({ id: item.id, title: lib.book(item.id)?.title ?? '', error: err.stderr ?? err.message ?? '失败' })
        }
      }
      if (updated) ctx.reload()
      return { ok: failed.length === 0, updated, failed }
    }
  )
}
