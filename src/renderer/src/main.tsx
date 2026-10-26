import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'
import { applyAppearance } from './lib/appearance'

// 在 React 挂载前把上次的外观铺上（否则深色主题会先闪一下浅色）
try {
  const cached = localStorage.getItem('eebookk.appearance')
  if (cached) applyAppearance(JSON.parse(cached) as never)
} catch {
  /* 缓存坏了就走默认浅色 */
}

// 有些 action 拿不到结果时只 reject，没有 catch；兜底记一笔并提示，别让界面毫无反应
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason as { message?: string })?.message ?? e.reason)
  if (msg.includes('已取消')) return
  void window.api.invoke('app:logError', `未处理的调用失败: ${msg}`, '').catch(() => undefined)
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
