import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface EebookkApi {
  /** 通用 IPC 调用。频道名统一走 src/shared/ipc.ts 的 CH */
  /** 拖进来的 File → 磁盘绝对路径（Electron 32 起 File.path 已移除） */
  pathForFile: (file: File) => string
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  /** 订阅主进程事件，返回取消订阅函数 */
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
  minimize: () => void
  maximize: () => void
  close: () => void
}

const api: EebookkApi = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>,
  on: (channel, cb) => {
    const handler = (_e: unknown, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.off(channel, handler)
  },
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close')
}

contextBridge.exposeInMainWorld('api', api)
