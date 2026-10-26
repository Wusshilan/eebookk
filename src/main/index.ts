import { app, BrowserWindow, ipcMain, nativeTheme, protocol, net, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '../shared/ipc'
import { ctx } from './ctx'
import { SettingsStore } from './settings'
import { isCalibreRunning, requestCloseCalibre } from './env'
import { registerLibraryActions } from './library-actions'
import { registerWorkbench } from './workbench'
import { registerConvert } from './convert'
import { registerDevice } from './device'
import { registerCollections } from './collections'
import { registerTaxonomy } from './taxonomy'
import { registerEpub } from './epub'
import { registerSources } from './sources'
import { registerMeta } from './meta'
import { registerEpubEdit } from './epub-edit'
import { applyCover, pickCoverImage, readCoverDataUrl, removeCover } from './cover'
import { checkForUpdates } from './updates'
import { installProcessHandlers, logger } from './logger'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bookcover',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  },
  {
    // 内置阅读器：epubres://<bookId>/<包内路径>
    scheme: 'epubres',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

const shotArg = process.argv.find((a) => a.startsWith('--shot='))
const shotPath = shotArg?.slice('--shot='.length)

// 未捕获异常一律落盘，发布版出问题才有现场
installProcessHandlers()
/** 截图校验时可以指定初始页面，例如 --shot-route=library */
const routeArg = process.argv.find((a) => a.startsWith('--shot-route='))
const shotRoute = routeArg?.slice('--shot-route='.length)
/** 截图尺寸，形如 --shot-size=1440x900，用来验证窗口自适应 */
const sizeArg = process.argv.find((a) => a.startsWith('--shot-size='))
const shotSize = (() => {
  const raw = sizeArg?.split('=')[1]
  const m = raw ? /^(\d+)x(\d+)$/.exec(raw) : null
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
})()

// 截图校验时必须 1:1 像素，否则拿不到 1920×1080
if (shotPath) {
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('high-dpi-support', '1')
  // 本机 GPU 缓存一直报 "Gpu Cache Creation failed"，硬件合成下 capturePage
  // 偶尔会返回空白帧；走软件渲染后截图稳定。
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: shotPath ? (shotSize?.width ?? 1920) : 1600,
    height: shotPath ? (shotSize?.height ?? 1080) : 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    // 深色系统下窗口底色也要深，否则开窗那一下会白闪
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#f6f6f6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // preload 只用 contextBridge / ipcRenderer，不需要 Node 能力，沙箱可以开着
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  ctx.window = mainWindow

  // 渲染层只允许停在自家页面；任何外链一律交给系统浏览器，不在应用里开窗
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const allowedPrefix = devUrl && devUrl.length > 0 ? devUrl : 'file://'
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(allowedPrefix)) {
      e.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logger.error('renderer 进程异常退出', details)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error('页面加载失败', { code, desc, url })
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}${shotRoute ? `#${shotRoute}` : ''}`
    )
  } else {
    mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      shotRoute ? { hash: shotRoute } : undefined
    )
  }

  if (shotPath) {
    // 截图校验时把渲染进程的 console / 崩溃信息打到 stdout，方便定位白屏
    mainWindow.webContents.on('console-message', (event: unknown) => {
      const e = event as { message?: string; level?: string; lineNumber?: number; sourceId?: string }
      if (e && typeof e.message === 'string') {
        console.log(`[renderer:${e.level ?? '?'}] ${e.message} @${e.sourceId ?? ''}:${e.lineNumber ?? 0}`)
      } else {
        console.log('[renderer]', JSON.stringify(event))
      }
    })
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.log(`[renderer-gone] ${JSON.stringify(details)}`)
    })
    mainWindow.webContents.on('preload-error', (_e, p, err) => {
      console.log(`[preload-error] ${p} ${String(err)}`)
    })
    mainWindow.webContents.once('did-finish-load', () => {
      const delay = Number(process.env.EEBOOKK_SHOT_DELAY ?? 4500)
      setTimeout(async () => {
        if (!mainWindow) {
          app.quit()
          return
        }
        // 无论截图成功与否都必须退出，否则进程会一直挂在后台
        try {
          // 需要点开弹层再截图时，用 EEBOOKK_SHOT_JS 注入一段点击脚本
          const shotJs = process.env.EEBOOKK_SHOT_JS
          if (shotJs && mainWindow) {
            try {
              const injected = await mainWindow.webContents.executeJavaScript(shotJs)
              if (injected !== undefined) console.log(`[shot-js] ${JSON.stringify(injected)}`)
              await new Promise((r) => setTimeout(r, 700))
            } catch (e) {
              console.log(`[shot-js-error] ${String(e)}`)
            }
          }
          try {
            const text = await mainWindow.webContents.executeJavaScript(
              'JSON.stringify({hash: location.hash, w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, cards: document.querySelectorAll(".card").length}) + " | " + document.body.innerText.replace(/\\s+/g, " ").slice(0, 120)'
            )
            console.log(`[dom] ${text}`)
          } catch (e) {
            console.log(`[dom-error] ${String(e)}`)
          }
          const image = await mainWindow.webContents.capturePage()
          let buf = image.toPNG()
          // capturePage 偶发返回空白帧（本机 GPU 合成有问题），用体量兜底重试
          for (let i = 0; i < 3 && buf.length < 60_000; i += 1) {
            await new Promise((r) => setTimeout(r, 700))
            if (!mainWindow) break
            buf = (await mainWindow.webContents.capturePage()).toPNG()
          }
          mkdirSync(dirname(shotPath), { recursive: true })
          await writeFile(shotPath, buf)
        } catch (e) {
          console.log(`[shot-error] ${String(e)}`)
        } finally {
          app.quit()
        }
      }, delay)
    })
  }
}

app.whenReady().then(async () => {
  ctx.settings = new SettingsStore()
  ctx.calibreRunning = await isCalibreRunning()
  ctx.ensureLibrary()
  logger.info('应用启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    library: ctx.library?.root ?? '(未找到)',
    libraryBooks: ctx.library?.all().length ?? 0,
    calibreRunning: ctx.calibreRunning
  })

  protocol.handle('bookcover', async (request) => {
    const url = new URL(request.url)
    const id = Number(url.pathname.replace(/^\//, ''))
    const file = ctx.library?.coverPath(id)
    if (!file) return new Response('', { status: 404 })
    const src = await net.fetch(pathToFileURL(file).toString())
    // 封面编辑器要用 fetch 把图读成像素来裁剪，跨源必须放行，否则 canvas 会被污染
    const headers = new Headers(src.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cache-Control', 'no-cache')
    return new Response(src.body, { status: 200, headers })
  })

  ipcMain.handle(CH.libraryLoad, () => ctx.payload())
  ipcMain.handle(CH.libraryReload, () => ctx.reload())

  ipcMain.handle(CH.envCalibreRunning, async () => {
    ctx.calibreRunning = await isCalibreRunning()
    return ctx.calibreRunning
  })
  ipcMain.handle(CH.envKillCalibre, async () => {
    await requestCloseCalibre()
    // 等进程真正退出，最多 6s
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 500))
      ctx.calibreRunning = await isCalibreRunning()
      if (!ctx.calibreRunning) break
    }
    ctx.emit(CH.envCalibreRunning, ctx.calibreRunning)
    return ctx.calibreRunning
  })

  ipcMain.handle(CH.settingsGet, () => ctx.settings?.get())
  ipcMain.handle(CH.settingsSet, (_e, patch) => {
    const next = ctx.settings?.update(patch as never)
    // 书库路径变了要重开
    if (patch && typeof patch === 'object' && 'libraryPath' in patch) {
      ctx.library = null
      ctx.ensureLibrary()
    }
    return next
  })

  ipcMain.handle(CH.libraryOpenBook, async (_e, id: number, format?: string) => {
    const file = ctx.library?.filePath(id, format)
    if (!file) return { ok: false, message: '找不到这本书的文件' }
    const err = await shell.openPath(file)
    return { ok: !err, message: err }
  })

  ipcMain.handle(CH.updateCheck, (_e, force?: boolean) => checkForUpdates(Boolean(force)))
  ipcMain.handle(CH.openExternal, (_e, url: string) => shell.openExternal(url))
  ipcMain.handle(CH.logError, (_e, message: string, detail?: string) => {
    logger.error(`[renderer] ${message}`, detail)
  })
  ipcMain.handle(CH.coverPick, () => pickCoverImage())
  ipcMain.handle(CH.coverRead, (_e, id: number) => readCoverDataUrl(id))
  ipcMain.handle(CH.coverApply, (_e, id: number, dataUrl: string) => applyCover(id, dataUrl))
  ipcMain.handle(CH.coverRemove, (_e, id: number) => removeCover(id))

  registerLibraryActions()
  registerWorkbench()
  registerConvert()
  registerDevice()
  registerCollections()
  registerTaxonomy()
  registerEpub()
  registerSources()
  registerMeta()
  registerEpubEdit()

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
