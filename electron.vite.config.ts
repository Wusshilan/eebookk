import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * 只在构建产物里注入 CSP。
 * 开发模式有 HMR（websocket + eval），注入会打断热更新，所以 apply 限定 build。
 */
function cspPlugin(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' bookcover: epubres: https: data: blob:",
    "font-src 'self' epubres: data:",
    "connect-src 'self' bookcover: epubres:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // 阅读器用 iframe 装载 EPUB 章节
    "frame-src 'self' epubres:"
  ].join('; ')

  return {
    name: 'eebookk-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const meta = `    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n`
      return html.replace(/<head>/, `<head>\n${meta}`)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [react(), cspPlugin()]
  }
})
