import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, SmtpSettings } from '../shared/types'
import { detectLibraryPath } from './calibre'

const DEFAULTS: AppSettings = {
  libraryPath: null,
  smtp: {
    enabled: false,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: '',
    hasPassword: false,
    from: '',
    kindleEmail: ''
  },
  convert: { defaultTarget: 'epub', extraArgs: '', concurrency: 2, outputDir: '' },
  appearance: {
    theme: 'light',
    accent: 'green',
    coverRadius: 6,
    gridMin: 140,
    cornerStyle: 'squircle',
    sidebarWidth: 306
  },
  update: { endpoint: '', autoCheck: true },
  general: { closeToTray: false, restoreLastPage: false },
  metadata: { authorSeparator: ' & ', tagSeparator: ',', embedOnSave: false },
  device: { usbSubdir: 'eebookk', maxAttachmentMB: 25 },
  web: { sources: ['douban', 'weread'], minCoverWidth: 200 },
  shortcuts: {
    search: 'Ctrl+K',
    home: 'Ctrl+1',
    library: 'Ctrl+2',
    workbench: 'Ctrl+3',
    convert: 'Ctrl+4',
    device: 'Ctrl+5',
    settings: 'Ctrl+,',
    theme: 'Ctrl+J'
  },
  sources: [
    {
      id: 'gutenberg',
      name: 'Project Gutenberg',
      kind: 'opds',
      url: 'https://www.gutenberg.org/ebooks.opds/',
      searchUrl: 'https://www.gutenberg.org/ebooks/search.opds/?query={q}',
      enabled: true,
      builtin: true
    },
    {
      id: 'standardebooks',
      name: 'Standard Ebooks',
      kind: 'opds',
      url: 'https://standardebooks.org/feeds/opds',
      searchUrl: 'https://standardebooks.org/feeds/opds/all?query={q}',
      enabled: false,
      builtin: true
    },
    {
      id: 'feedbooks',
      name: 'Feedbooks 公共版权',
      kind: 'opds',
      url: 'https://catalog.feedbooks.com/catalog/public_domain.atom',
      searchUrl: 'https://catalog.feedbooks.com/search.atom?query={q}',
      enabled: false,
      builtin: true
    }
  ]
}

interface StoredFile extends AppSettings {
  /** safeStorage 加密后的 SMTP 授权码（base64），只存在本地 */
  smtpPasswordEnc?: string
}

export class SettingsStore {
  private file: string
  private data: StoredFile
  private password = ''

  constructor() {
    this.file = join(app.getPath('userData'), 'settings.json')
    this.data = this.load()
  }

  private load(): StoredFile {
    const base: StoredFile = {
      ...DEFAULTS,
      smtp: { ...DEFAULTS.smtp },
      convert: { ...DEFAULTS.convert },
      appearance: { ...DEFAULTS.appearance },
      update: { ...DEFAULTS.update },
      general: { ...DEFAULTS.general },
      metadata: { ...DEFAULTS.metadata },
      device: { ...DEFAULTS.device },
      web: { ...DEFAULTS.web },
      shortcuts: { ...DEFAULTS.shortcuts },
      // 数组要深拷贝，否则改一处会把 DEFAULTS 本身带脏
      sources: DEFAULTS.sources.map((s) => ({ ...s }))
    }
    if (!existsSync(this.file)) {
      base.libraryPath = detectLibraryPath()
      return base
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredFile>
      const merged: StoredFile = {
        ...base,
        ...raw,
        smtp: { ...base.smtp, ...(raw.smtp ?? {}) },
        convert: { ...base.convert, ...(raw.convert ?? {}) },
        appearance: { ...base.appearance, ...(raw.appearance ?? {}) },
        update: { ...base.update, ...(raw.update ?? {}) },
        general: { ...base.general, ...(raw.general ?? {}) },
        metadata: { ...base.metadata, ...(raw.metadata ?? {}) },
        device: { ...base.device, ...(raw.device ?? {}) },
        web: { ...base.web, ...(raw.web ?? {}) },
        shortcuts: { ...base.shortcuts, ...(raw.shortcuts ?? {}) }
      }
      if (raw.smtpPasswordEnc) {
        try {
          this.password = safeStorage.decryptString(Buffer.from(raw.smtpPasswordEnc, 'base64'))
        } catch {
          this.password = ''
        }
      }
      merged.smtp.hasPassword = this.password.length > 0
      return merged
    } catch {
      return base
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const out: StoredFile = { ...this.data }
    if (this.password && safeStorage.isEncryptionAvailable()) {
      out.smtpPasswordEnc = safeStorage.encryptString(this.password).toString('base64')
    }
    writeFileSync(this.file, JSON.stringify(out, null, 2), 'utf8')
  }

  get(): AppSettings {
    return this.data
  }

  update(patch: Partial<AppSettings> & { smtpPassword?: string }): AppSettings {
    const { smtpPassword, ...rest } = patch
    if (rest.smtp) this.data.smtp = { ...this.data.smtp, ...rest.smtp }
    if (rest.convert) this.data.convert = { ...this.data.convert, ...rest.convert }
    if (rest.appearance) this.data.appearance = { ...this.data.appearance, ...rest.appearance }
    if (rest.update) this.data.update = { ...this.data.update, ...rest.update }
    if (rest.general) this.data.general = { ...this.data.general, ...rest.general }
    if (rest.metadata) this.data.metadata = { ...this.data.metadata, ...rest.metadata }
    if (rest.device) this.data.device = { ...this.data.device, ...rest.device }
    if (rest.web) this.data.web = { ...this.data.web, ...rest.web }
    if (rest.shortcuts) this.data.shortcuts = { ...this.data.shortcuts, ...rest.shortcuts }
    if (Array.isArray(rest.sources)) {
      // 内置源不能删：patch 里漏掉的按 id 补回来，只允许改 url / searchUrl / enabled
      const kept = rest.sources.filter((s) => s && typeof s.id === 'string')
      const missing = this.data.sources.filter(
        (s) => s.builtin && !kept.some((k) => k.id === s.id)
      )
      this.data.sources = [...kept, ...missing.map((s) => ({ ...s }))]
    }
    if (rest.libraryPath !== undefined) this.data.libraryPath = rest.libraryPath
    if (typeof smtpPassword === 'string') this.password = smtpPassword
    this.data.smtp.hasPassword = this.password.length > 0
    this.persist()
    return this.data
  }

  smtp(): SmtpSettings {
    return this.data.smtp
  }

  smtpPassword(): string {
    return this.password
  }
}
