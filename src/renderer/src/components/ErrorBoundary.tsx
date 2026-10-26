import React from 'react'
import { CH } from '../../../shared/ipc'

interface State {
  error: Error | null
  info: string
}

/**
 * 顶层错误边界。
 * 没有它的话，任何渲染异常都会让整个窗口变成纯白 —— 用户连「出了什么事」都不知道。
 */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const detail = `${error.stack ?? error.message}\n---\n${info.componentStack ?? ''}`
    this.setState({ info: detail })
    // 送到主进程写进 userData/logs/app.log
    void window.api
      .invoke(CH.logError, `渲染异常: ${error.message}`, detail)
      .catch(() => undefined)
  }

  private reload = (): void => {
    location.reload()
  }

  private copy = (): void => {
    const text = `${this.state.error?.message ?? ''}\n${this.state.info}`
    void navigator.clipboard.writeText(text).catch(() => undefined)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-mark">!</div>
          <h1 className="crash-title">界面出了点问题</h1>
          <p className="crash-msg">
            这不是你的操作导致的。点「重新加载」通常能恢复；如果反复出现，把下面的错误信息发给我。
          </p>
          <pre className="crash-detail">{error.message}</pre>
          <div className="crash-actions">
            <button className="btn btn-primary" onClick={this.reload}>
              重新加载
            </button>
            <button className="btn" onClick={this.copy}>
              复制错误信息
            </button>
          </div>

        </div>
      </div>
    )
  }
}
