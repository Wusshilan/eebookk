import { createContext, useContext } from 'react'
import type { Book, CollectionsStore, LibraryPayload, LibraryStats } from '../../../shared/types'

export type Route =
  | { name: 'home' }
  | { name: 'library'; tag?: string; author?: string; series?: string }
  | { name: 'book'; id: number }
  | { name: 'workbench'; issue?: string }
  | { name: 'convert' }
  | { name: 'device' }
  | { name: 'settings' }
  | { name: 'tags' }
  | { name: 'authors' }
  | { name: 'favorites' }
  | { name: 'list'; id: string }
  | { name: 'reader'; id: number }
  | { name: 'editor'; id: number }

export interface AppApi {
  payload: LibraryPayload
  books: Book[]
  stats: LibraryStats
  reload: () => Promise<void>
  route: Route
  navigate: (r: Route) => void
  back: () => void
  canBack: boolean
  selected: number[]
  setSelected: (ids: number[]) => void
  toggleSelected: (id: number) => void
  clearSelection: () => void
  toast: (msg: string, kind?: 'info' | 'success' | 'error') => void
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  search: string
  setSearch: (s: string) => void
  /** calibre 运行时为 true，此时所有写操作禁用 */
  calibreRunning: boolean
  refreshEnv: () => Promise<void>
  /** 收藏与书单，存在本应用自己的 store 里，不写 calibre */
  collections: CollectionsStore
  reloadCollections: () => Promise<void>
  toggleFavorite: (bookId: number) => Promise<void>
  isFavorite: (bookId: number) => boolean
  /** 应用内确认框，替代 window.confirm */
  confirm: (opts: {
    title: string
    message?: string
    okText?: string
    cancelText?: string
    danger?: boolean
  }) => Promise<boolean>
  /** 应用内输入框，替代 window.prompt；取消返回 null */
  ask: (opts: {
    title: string
    message?: string
    label?: string
    defaultValue?: string
    placeholder?: string
    okText?: string
  }) => Promise<string | null>
}

export const AppCtx = createContext<AppApi | null>(null)

export function useApp(): AppApi {
  const v = useContext(AppCtx)
  if (!v) throw new Error('useApp 必须在 AppCtx 内使用')
  return v
}
