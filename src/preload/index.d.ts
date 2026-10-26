import type { EebookkApi } from './index'

declare global {
  interface Window {
    api: EebookkApi
  }
}

export {}
