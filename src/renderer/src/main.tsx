import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'

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
