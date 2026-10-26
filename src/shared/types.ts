/** 主进程 / preload / 渲染进程共用的数据结构 */

export interface Book {
  id: number
  title: string
  authors: string
  series: string | null
  seriesIndex: number | null
  tags: string[]
  formats: string[]
  hasCover: boolean
  timestamp: string
  pubdate: string
  rating: number | null
  /** 简介字符数，0 表示没有简介 */
  descLen: number
  /** 阅读进度 0..1，来自 calibre 的 last_read_positions */
  posFrac: number | null
  readEpoch: number | null
  /** 相对书库根目录的书籍目录，用于拼封面路径 */
  relPath: string
  /** 主格式文件字节数 */
  sizeBytes: number
  publisher: string | null
  subtitle?: string
  authorSort?: string
  languages: string | null
  /** ISBN / ASIN 等标识符，形如 { isbn: '978...' } */
  identifiers: Record<string, string>
  /** 备注（calibre 的 comments），纯文本，可能为空 */
  comments: string
  /** 自定义列值，key 是列标签（如 '#genre'） */
  custom?: Record<string, string>
}

/** calibre 的自定义列定义 */
export interface CustomColumn {
  id: number
  /** '#genre' 这种，写库时用它 */
  label: string
  name: string
  datatype: string
  isMultiple: boolean
  /** 枚举列的取值 */
  options: string[]
}

export interface LibraryStats {
  total: number
  withDesc: number
  withTags: number
  withSeries: number
  withRating: number
  withCover: number
  withIdentifier: number
  epub: number
  started: number
  tags: number
  authors: number
  series: number
  publishers: number
}

export interface LibraryPayload {
  path: string
  calibreVersion: string | null
  calibreRunning: boolean
  stats: LibraryStats
  books: Book[]
}

/* ---------------- 整理台 ---------------- */

export interface TagStat {
  name: string
  count: number
  /** 判定为下载站水印 / 乱码 / 无意义标签 */
  suspicious: boolean
  reason?: string
}

export interface QualityIssue {
  key: 'missing-desc' | 'missing-tags' | 'missing-cover' | 'missing-identifier' | 'suspicious-tags' | 'duplicate-title' | 'no-epub'
  label: string
  count: number
  /** 命中该问题的书 id */
  bookIds: number[]
  severity: 'high' | 'medium' | 'low'
  hint: string
}

export interface QualityReport {
  score: number
  total: number
  issues: QualityIssue[]
  tags: TagStat[]
}

export interface MetadataPatch {
  title?: string
  authors?: string[]
  series?: string | null
  seriesIndex?: number | null
  tags?: string[] | null
  rating?: number | null
  comments?: string | null
  publisher?: string | null
  /** 语言代码，如 'chi' */
  languages?: string[]
  /** 出版日期，只传 YYYY-MM-DD；null 表示清空 */
  pubdate?: string | null
  subtitle?: string | null
  authorSort?: string | null
  /** 标识符，形如 { isbn: '978...', 'mobi-asin': 'B0...' }；传 {} 表示全清 */
  identifiers?: Record<string, string>
  /** 自定义列，key 用 '#label'；null 表示清空该列 */
  custom?: Record<string, string | null>
}

export interface EditResult {
  ok: boolean
  updated: number
  failed: { id: number; title: string; error: string }[]
}

/* ---------------- 转换 ---------------- */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface ConvertJob {
  id: string
  bookId: number
  title: string
  from: string
  to: string
  status: JobStatus
  /** 0..100 */
  percent: number
  stage: string
  message?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  outputPath?: string
}

/* ---------------- 设备 ---------------- */

export interface KindleDevice {
  mountPath: string
  label: string
  freeBytes: number
  totalBytes: number
  /** 设备上已有的书名/文件名，用于判断是否已推送过 */
  documentCount: number
}

export interface SendResult {
  ok: boolean
  message: string
}

/* ---------------- 设置 ---------------- */

export interface SmtpSettings {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  user: string
  /** 是否已保存密码 */
  hasPassword: boolean
  from: string
  kindleEmail: string
}

export interface UpdateSettings {
  /** 版本清单地址，返回 { version, url, notes }；留空表示不做更新检查 */
  endpoint: string
  autoCheck: boolean
}

export interface GeneralSettings {
  /** 关闭窗口时最小化到托盘而不是退出 */
  closeToTray: boolean
  /** 启动时恢复上次停留的页面 */
  restoreLastPage: boolean
}

export interface AppearanceSettings {
  /** system 跟随系统 */
  theme: 'light' | 'dark' | 'system'
  /** 主色调 */
  accent: 'green' | 'blue' | 'purple' | 'orange' | 'rose'
  /** 封面圆角，0–40 */
  coverRadius: number
  /** 每行封面的最小宽度，越大每行越少 */
  gridMin: number
  /** 圆角风格：圆角 / 超椭圆 */
  cornerStyle: 'round' | 'squircle'
  /** 侧栏宽度 */
  sidebarWidth: number
}

export interface ConvertSettings {
  defaultTarget: string
  extraArgs: string
  /** 同时转换几本，1–4 */
  concurrency: number
  /** 输出目录，留空则用 userData/exports */
  outputDir: string
}

export interface MetadataSettings {
  /** 多作者写回 calibre 时用的分隔符，calibre 默认 & */
  authorSeparator: string
  /** 多标签写回时的分隔符，calibre 用英文逗号 */
  tagSeparator: string
  /** 保存元数据后顺手写进书籍文件 */
  embedOnSave: boolean
}

export interface DeviceSettings {
  /** Kindle 上存放的子目录名，位于 documents/ 下 */
  usbSubdir: string
  /** 邮件推送只发 EPUB / PDF / DOCX */
  maxAttachmentMB: number
}

export interface ShortcutSettings {
  search: string
  home: string
  library: string
  workbench: string
  convert: string
  device: string
  settings: string
  theme: string
}

export interface AppSettings {
  libraryPath: string | null
  smtp: SmtpSettings
  convert: ConvertSettings
  appearance: AppearanceSettings
  update: UpdateSettings
  general: GeneralSettings
  metadata: MetadataSettings
  device: DeviceSettings
  /** 外部书目源（OPDS），内置源默认带三条 */
  sources: BookSource[]
  /** 全网元数据 / 封面检索 */
  web: WebMetaSettings
  /** 全局快捷键 */
  shortcuts: ShortcutSettings
}

/* ---------------- 收藏 / 书单 ---------------- */

export interface BookList {
  id: string
  name: string
  bookIds: number[]
  createdAt: number
  updatedAt: number
}

export interface CollectionsStore {
  /** 收藏的书 id，顺序即添加顺序 */
  favorites: number[]
  lists: BookList[]
}

/* ---------------- 标签 / 作者聚合 ---------------- */

export interface TaxonomyRow {
  name: string
  count: number
  bookIds: number[]
}

export interface TaxonomySummary {
  tags: TaxonomyRow[]
  authors: TaxonomyRow[]
  series: TaxonomyRow[]
  publishers: TaxonomyRow[]
}

/* ---------------- 更新检查 ---------------- */

export interface UpdateInfo {
  /** 只有确实检测到更高版本才为 true —— 侧栏「更新」角标据此显示 */
  hasUpdate: boolean
  current: string
  latest: string | null
  url: string | null
  notes: string | null
  checkedAt: number
  /** 未配置 / 网络失败时的原因，hasUpdate 恒为 false */
  message?: string
}

/* ---------------- 内置阅读器 ---------------- */

export interface ReaderSpineItem {
  href: string
  label: string
}

export interface ReaderInfo {
  bookId: number
  title: string
  authors: string
  /** 资源基地址，章节里的图片/CSS 都相对它解析 */
  base: string
  spine: ReaderSpineItem[]
  /** 打开前的阅读位置（0..1） */
  posFrac: number | null
  error?: string
}

/* ---------------- 回收站 ---------------- */

export interface TrashEntry {
  /** 删除时的时间戳目录名 */
  stamp: string
  /** 书籍目录绝对路径 */
  path: string
  title: string
  /** 目录里的文件数 */
  files: number
}

/* ---------------- 内置电子书编辑器 ---------------- */

export interface EpubFileEntry {
  /** 包内绝对路径 */
  path: string
  /** 短名，列表显示用 */
  name: string
  size: number
  kind: 'html' | 'css' | 'opf' | 'image' | 'font' | 'other'
  /** 能不能在编辑器里改 */
  editable: boolean
}

export interface EpubFileContent {
  path: string
  text: string
  /** ok / binary（图片等不支持编辑）/ too-large / missing */
  status: 'ok' | 'binary' | 'too-large' | 'missing'
  bytes: number
}

/* ---------------- 外部书目源（OPDS） ---------------- */

export interface BookSource {
  id: string
  name: string
  /** 目前只支持 OPDS（Atom 目录），calibre 用的也是这套 */
  kind: 'opds'
  /** 目录根地址：打开「随便看看」时用 */
  url: string
  /** 搜索地址模板，{q} 会被替换成关键词 */
  searchUrl: string
  enabled: boolean
  /** 内置源不可删，只能停用 */
  builtin?: boolean
}

export interface CatalogItem {
  /** 源内唯一标识，一般是详情地址 */
  id: string
  sourceId: string
  sourceName: string
  title: string
  authors: string
  cover: string | null
  summary: string
  /** 下载地址；列表阶段可能为空，点下载时再解析 */
  downloadUrl: string | null
  format: string
  sizeBytes: number
  language: string
}

export interface CatalogPage {
  sourceId: string
  items: CatalogItem[]
  next: string | null
  error?: string
}

/* ---------------- 全网元数据 / 封面检索 ---------------- */

export interface WebMetaHit {
  /** 来源标识：douban / neodb */
  source: string
  sourceName: string
  /** 源内 id，回填详情用 */
  id: string
  title: string
  authors: string
  publisher: string
  pubdate: string
  isbn: string
  language: string
  rating: number | null
  summary: string
  coverUrl: string | null
  /** 封面实际像素，用来让用户按清晰度挑 */
  coverWidth: number | null
  coverHeight: number | null
  url: string
}

export interface WebMetaSettings {
  /** 启用的来源 */
  sources: string[]
  /** 低于这个宽度的封面不参与挑选 */
  minCoverWidth: number
}

/* ---------------- 事件推送 ---------------- */

export interface TaskSnapshot {
  converts: ConvertJob[]
  /** 最近推送 / 最近阅读，供底部常驻条展示 */
  lastSend?: { title: string; ok: boolean; at: number; message: string }
  reading?: { bookId: number; title: string; posFrac: number | null; at: number } | null
}
