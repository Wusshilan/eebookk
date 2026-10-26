/** IPC 频道名集中定义，主进程与渲染进程共用，避免拼错 */

export const CH = {
  // 书库
  libraryLoad: 'library:load',
  libraryReload: 'library:reload',
  libraryOpenBook: 'library:open',
  libraryRevealBook: 'library:reveal',
  libraryRemove: 'library:remove',
  libraryAdd: 'library:add',
  libraryBackup: 'library:backup',
  libraryColumns: 'library:columns',
  openCalibre: 'app:openCalibre',
  pickDirectory: 'app:pickDirectory',
  /** 在文件管理器里定位任意路径（转换产物等） */
  revealPath: 'app:revealPath',
  // 进程 / 环境
  envCalibreRunning: 'env:calibreRunning',
  envKillCalibre: 'env:killCalibre',
  // 整理台
  qualityReport: 'quality:report',
  metadataApply: 'metadata:apply',
  tagsCleanup: 'tags:cleanup',
  // 转换
  convertEnqueue: 'convert:enqueue',
  convertCancel: 'convert:cancel',
  convertClearFinished: 'convert:clear',
  convertList: 'convert:list',
  // 设备 / 推送
  deviceDetect: 'device:detect',
  deviceProbe: 'device:probe',
  deviceSend: 'device:send',
  smtpTest: 'smtp:test',
  // 设置
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // 更新检查
  updateCheck: 'update:check',
  openExternal: 'shell:openExternal',
  // 渲染层把错误写进主进程日志
  logError: 'app:logError',
  // 封面
  coverPick: 'cover:pick',
  coverApply: 'cover:apply',
  coverRemove: 'cover:remove',
  coverRead: 'cover:read',
  // calibre 单本操作
  bookEdit: 'book:edit',
  bookPolish: 'book:polish',
  bookExport: 'book:export',
  bookEmbed: 'book:embed',
  // 标签 / 作者（批量改写 metadata.db）
  taxonomySummary: 'taxonomy:summary',
  tagRename: 'tag:rename',
  tagMerge: 'tag:merge',
  tagDelete: 'tag:delete',
  authorRename: 'author:rename',
  // 收藏 / 书单（存在本应用自己的 store，不动 calibre）
  collectionsGet: 'collections:get',
  favoriteToggle: 'favorite:toggle',
  listCreate: 'list:create',
  listRename: 'list:rename',
  listDelete: 'list:delete',
  listAddBooks: 'list:addBooks',
  listRemoveBooks: 'list:removeBooks',
  // 内置阅读器
  readerInfo: 'reader:info',
  readerSaveProgress: 'reader:saveProgress',
  /** 一次性取回本应用记录的所有阅读进度 */
  readerProgress: 'reader:progress',

  // 外部书目源
  sourcesList: 'sources:list',
  sourcesSave: 'sources:save',
  sourcesBrowse: 'sources:browse',
  sourcesSearch: 'sources:search',
  sourcesDownload: 'sources:download',

  // 全网元数据 / 封面
  metaSearch: 'meta:search',
  metaDetail: 'meta:detail',
  coverSearch: 'meta:coverSearch',
  coverApplyUrl: 'meta:coverApplyUrl',

  // 回收站
  trashList: 'trash:list',
  trashRestore: 'trash:restore',
  trashClear: 'trash:clear',

  // 内置电子书编辑器
  epubList: 'epubEdit:list',
  epubRead: 'epubEdit:read',
  epubWrite: 'epubEdit:write',
  epubRevert: 'epubEdit:revert',
  epubBackupList: 'epubEdit:backups',

  // 事件（主进程 -> 渲染进程）
  evtTasks: 'evt:tasks',
  evtCollections: 'evt:collections',
  /** 标签/作者批量改写的进度 */
  evtTaxonomy: 'evt:taxonomy',
  /** 阅读进度变化 */
  evtReading: 'evt:reading'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
