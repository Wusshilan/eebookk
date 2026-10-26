import { useCallback, useEffect, useMemo, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { TaxonomySummary } from '../../../shared/types'
import { useApp } from '../app/context'
import { useTaxonomyProgress } from '../lib/useTaxonomyProgress'
import { IconCheck, IconRefresh, IconTrash } from '../icons'

/** 主进程 taxonomy.ts 返回的结构；shared 里没有这个类型，也不允许改 shared，这里本地声明 */
interface TaxonomyEditResult {
  ok: boolean
  updated: number
  failed: { id: number; title: string; error: string }[]
  message?: string
}

/**
 * 危险标签判定，规则与 src/main/workbench.ts 的 suspiciousTag 完全一致。
 * 主进程模块不能直接 import 进渲染层（会拖进 electron），所以这里复制一份。
 */
const PIRACY = /(z-?lib|annas?\s*archive|sanqiu|sobooks|jiumodiary|周读|书栈|鸠摩|天浪|汇书|雅书|电子书分享|读书会)/i
const WATERMARK = /(公众号|微信号|微信|qq\s*群|企鹅群|扫码|关注|分享更多|免费分享|更多好书|搜索雅书|资源分享)/i
const URLISH = /(www\.|https?:|\.com\b|\.net\b|\.org\b|\.cn\b|\.mobi\b|\.epub\b|\.azw3\b|\.txt\b|\.pdf\b)/i
const EXACT_JUNK = new Set([
  '书库', '书屋', '书店', '书城', '书吧', '电子书', '下载', '免费',
  '资源', '未分类', '其它', '其他', '未知', '无', '未知作者', '未分类书籍'
])

function suspiciousTag(name: string): string | null {
  const s = name.trim()
  if (!s) return '空标签'
  if (PIRACY.test(s)) return '疑似盗版源标记'
  if (WATERMARK.test(s)) return '疑似下载站引流'
  if (URLISH.test(s)) return '疑似网址或文件格式'
  if (EXACT_JUNK.has(s)) return '无意义的通用词'
  if (s.length <= 6 && /[书文读]/.test(s) && /(网|屋|阁)$/.test(s)) return '疑似站点名'
  if (/^[\d\s\-_.,;:!?+*/\\|]+$/.test(s)) return '纯符号 / 数字'
  if (s.length <= 2 && !/[\u4e00-\u9fa5]/.test(s)) return '过短且无意义'
  return null
}

/** 药丸一次最多渲染这么多，标签上千时靠搜索收窄 */
const MAX_PILLS = 600

const CSS = `
.tx-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.tx-tag {
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding-left: 4px;
  border: 1px solid var(--hairline);
  border-radius: 17px;
  background: var(--surface);
  transition: border-color 0.14s ease, background-color 0.14s ease;
}
.tx-tag:hover {
  border-color: #cfe9da;
  background: var(--surface-2);
}
.tx-tag.is-warn {
  background: #fffaf0;
  border-color: #f0dcb8;
}
.tx-tag.is-on {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.tx-tag.is-warn.is-on {
  border-color: #e8c88a;
  background: #fdf3e0;
}
.tx-tag-check {
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #c9c9c9;
}
.tx-tag-check:hover {
  background: var(--surface-2);
  color: #9a9a9a;
}
.tx-tag.is-on .tx-tag-check {
  background: var(--accent);
  color: #fff;
}
.tx-tag-name {
  max-width: 240px;
  padding: 0 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  color: var(--t1);
}
.tx-tag-name:hover {
  color: var(--accent-press);
  text-decoration: underline;
}
.tx-tag-count {
  flex: none;
  margin: 0 9px 0 6px;
  padding: 1px 7px;
  border-radius: 9px;
  background: #f2f2f2;
  color: var(--t2);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.tx-tag.is-warn .tx-tag-count {
  background: #f9edd4;
  color: #9a6100;
}
.tx-warnbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 10px 14px;
  border: 1px solid #f5e1bb;
  border-radius: 10px;
  background: #fff8e9;
  color: #9a6100;
  font-size: 13.5px;
}
.tx-warnbar b {
  font-weight: 600;
}
.tx-warnbar-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--warn);
}
.tx-lock-note {
  font-size: 12.5px;
  color: #b56a00;
  white-space: nowrap;
}
.tx-more {
  margin: 16px 0 0;
  font-size: 13px;
  color: var(--t2);
}
.tx-foot {
  margin-top: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
}
`

export default function Tags(): React.ReactElement {
  const { books, navigate, invoke, reload, toast, calibreRunning, ask, confirm } = useApp()
  const progress = useTaxonomyProgress()

  const [summary, setSummary] = useState<TaxonomySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [sortKey, setSortKey] = useState<'count' | 'name'>('count')
  const [onlySuspicious, setOnlySuspicious] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.api.invoke<TaxonomySummary>(CH.taxonomySummary)
      setSummary(next ?? { tags: [], authors: [], series: [], publishers: [] })
    } catch {
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // 书库本数变化（增删书、整理台清理）时重新聚合
  useEffect(() => {
    void load()
  }, [load, books.length])

  const coveredBooks = useMemo(() => {
    const ids = new Set<number>()
    for (const tag of summary?.tags ?? []) for (const id of tag.bookIds) ids.add(id)
    return ids.size
  }, [summary])

  const suspiciousRows = useMemo(
    () => (summary?.tags ?? []).filter((tag) => suspiciousTag(tag.name) != null),
    [summary]
  )

  const suspiciousBooks = useMemo(() => {
    const ids = new Set<number>()
    for (const tag of suspiciousRows) for (const id of tag.bookIds) ids.add(id)
    return ids.size
  }, [suspiciousRows])

  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    let list = summary?.tags ?? []
    if (onlySuspicious) list = list.filter((tag) => suspiciousTag(tag.name) != null)
    if (kw) list = list.filter((tag) => tag.name.toLowerCase().includes(kw))
    const sorted = [...list]
    if (sortKey === 'count') {
      sorted.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    }
    return sorted
  }, [summary, keyword, sortKey, onlySuspicious])

  const visibleRows = rows.slice(0, MAX_PILLS)
  const allPicked = visibleRows.length > 0 && visibleRows.every((row) => picked.includes(row.name))
  const canEdit = !calibreRunning && !busy
  const lockHint = 'calibre 正在运行，calibredb 会拒绝写入。先完全退出 calibre 再操作。'

  const toggle = (name: string): void => {
    setPicked((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]))
  }

  const toggleAll = (): void => {
    if (allPicked) {
      const visible = new Set(visibleRows.map((row) => row.name))
      setPicked((prev) => prev.filter((name) => !visible.has(name)))
      return
    }
    setPicked((prev) => [...new Set([...prev, ...visibleRows.map((row) => row.name)])])
  }

  const runEdit = async (label: string, action: () => Promise<TaxonomyEditResult>): Promise<void> => {
    if (calibreRunning) {
      toast('calibre 正在运行，calibredb 会拒绝一切写入。请先退出 calibre。', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await action()
      if (!res.ok) {
        const first = res.failed[0]
        toast(
          res.message ?? (first ? `「${first.title}」写入失败：${first.error}` : `${label}失败`),
          'error'
        )
        return
      }
      toast(
        res.updated > 0 ? `${label}：${res.updated} 本书已更新` : `${label}：没有书需要改动`,
        'success'
      )
      setPicked([])
      await reload()
      await load()
    } catch (e) {
      toast(`${label}失败：${String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const renameTags = async (): Promise<void> => {
    if (picked.length !== 1) return
    const old = picked[0]
    const input = await ask({
      title: `重命名标签「${old}」`,
      label: '新名称',
      defaultValue: old,
      okText: '重命名'
    })
    if (input == null) return
    const next = input.trim()
    if (!next || next === old) return
    void runEdit(`重命名标签「${old}」`, () => invoke<TaxonomyEditResult>(CH.tagRename, old, next))
  }

  const mergeTags = async (): Promise<void> => {
    if (!picked.length) return
    const input = await ask({
      title:
        picked.length === 1
          ? `把标签「${picked[0]}」合并到…`
          : `把选中的 ${picked.length} 个标签合并到…`,
      message: '填已存在的标签名就并入它，填新名字会新建。',
      label: '目标标签',
      defaultValue: picked[0],
      okText: '合并'
    })
    if (input == null) return
    const target = input.trim()
    if (!target) return
    if (picked.length === 1 && target === picked[0]) return
    void runEdit(`合并 ${picked.length} 个标签`, () =>
      invoke<TaxonomyEditResult>(CH.tagMerge, picked, target)
    )
  }

  const deleteTags = async (): Promise<void> => {
    if (!picked.length) return
    const preview =
      picked.slice(0, 8).join('、') + (picked.length > 8 ? ` 等 ${picked.length} 个` : '')
    const yes = await confirm({
      title: `从所有书里删除这 ${picked.length} 个标签？`,
      message: preview,
      okText: '删除',
      danger: true
    })
    if (!yes) return
    void runEdit(`删除 ${picked.length} 个标签`, () =>
      invoke<TaxonomyEditResult>(CH.tagDelete, picked)
    )
  }

  const cleanWatermarks = async (): Promise<void> => {
    const names = suspiciousRows.map((row) => row.name)
    if (!names.length) return
    const preview = names.slice(0, 10).join('、') + (names.length > 10 ? ' …' : '')
    const yes = await confirm({
      title: `清理 ${names.length} 个疑似水印 / 垃圾标签？`,
      message: `共涉及 ${suspiciousBooks} 本书：\n\n${preview}\n\n把这些标签一次性从所有书里移除。`,
      okText: '清理',
      danger: true
    })
    if (!yes) return
    void runEdit(`清理 ${names.length} 个水印标签`, () =>
      invoke<TaxonomyEditResult>(CH.tagDelete, names)
    )
  }

  return (
    <div className="page">
      <style>{CSS}</style>

      {busy && progress ? (
        <div className="tx-progress">
          正在逐本写入 calibre … {progress.done}/{progress.total}
        </div>
      ) : null}

      <div className="page-head">
        <h1 className="page-title">分组 / 标签</h1>
        <span className="page-sub">
          {summary
            ? `${summary.tags.length} 个标签 · ${coveredBooks} 本书有标签`
            : loading
              ? '正在聚合…'
              : '还没有读到标签'}
        </span>
        <span className="spacer" />
        {calibreRunning ? <span className="lock-pill">calibre 运行中 · 只读</span> : null}
        <input
          className="input"
          style={{ width: 200 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <select
          className="select"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as 'count' | 'name')}
          title="排序方式"
        >
          <option value="count">按本数</option>
          <option value="name">按名称</option>
        </select>
        <button
          className={`btn btn-sm${onlySuspicious ? ' btn-primary' : ''}`}
          title="只看疑似水印 / 垃圾标签"
          onClick={() => setOnlySuspicious(!onlySuspicious)}
        >
          只看水印
        </button>
        <button className="btn btn-sm btn-ghost" disabled={loading} onClick={() => void load()}>
          <IconRefresh width={16} height={16} />
          刷新
        </button>
      </div>

      {suspiciousRows.length > 0 ? (
        <div className="tx-warnbar">
          <span className="tx-warnbar-dot" />
          <span>
            发现 <b>{suspiciousRows.length}</b> 个疑似水印 / 垃圾标签，共涉及 {suspiciousBooks} 本书
          </span>
          <span className="spacer" />
          {calibreRunning ? <span className="tx-lock-note">关闭 calibre 后才能清理</span> : null}
          <button
            className="btn btn-sm btn-danger"
            disabled={!canEdit}
            title={calibreRunning ? lockHint : '一次性从所有书里移除这些标签'}
            onClick={() => void cleanWatermarks()}
          >
            <IconTrash width={15} height={15} />
            一键清理水印标签
          </button>
        </div>
      ) : null}

      {picked.length > 0 ? (
        <div className="selbar">
          <span className="selbar-count">已选 {picked.length} 个标签</span>
          <button className="btn btn-sm" onClick={toggleAll}>
            {allPicked ? '取消全选' : '全选当前'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setPicked([])}>
            清空
          </button>
          <span className="spacer" />
          {calibreRunning ? (
            <span className="tx-lock-note">calibre 正在运行，改写已锁定</span>
          ) : null}
          <button
            className="btn btn-sm"
            disabled={!canEdit || picked.length !== 1}
            title={
              calibreRunning
                ? lockHint
                : picked.length !== 1
                  ? '重命名一次只能选一个标签'
                  : '把这个标签改成新名字'
            }
            onClick={() => void renameTags()}
          >
            重命名
          </button>
          <button
            className="btn btn-sm"
            disabled={!canEdit}
            title={calibreRunning ? lockHint : '把选中的标签合并成一个'}
            onClick={() => void mergeTags()}
          >
            合并到…
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={!canEdit}
            title={calibreRunning ? lockHint : '从所有书里移除这些标签'}
            onClick={() => void deleteTags()}
          >
            <IconTrash width={15} height={15} />
            删除
          </button>
        </div>
      ) : null}

      {!summary ? (
        <div className="empty">{loading ? '正在聚合标签…' : '读取失败，点右上角「刷新」重试'}</div>
      ) : summary.tags.length === 0 ? (
        <div className="empty">
          没有标签
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">没有匹配的标签</div>
      ) : (
        <>
          {[
            { key: 'hot', title: '常用', rows: visibleRows.filter((r) => r.count >= 3) },
            { key: 'mid', title: '一般', rows: visibleRows.filter((r) => r.count === 2) },
            { key: 'one', title: '只用过一次', rows: visibleRows.filter((r) => r.count === 1) }
          ]
            .filter((g) => g.rows.length > 0)
            .map((g) => (
              <section className="tx-group" key={g.key}>
                <h3 className="tx-group-head">
                  {g.title}
                  <span className="tx-group-num">{g.rows.length}</span>
                </h3>
                <div className="tx-cloud">
                  {g.rows.map((row) => {
              const reason = suspiciousTag(row.name)
              const on = picked.includes(row.name)
              return (
                <div key={row.name} className={`tx-tag${on ? ' is-on' : ''}${reason ? ' is-warn' : ''}`}>
                  <button
                    type="button"
                    className="tx-tag-check"
                    aria-label={on ? '取消选择' : '选择'}
                    title={on ? '取消选择' : '勾选后可以批量重命名 / 合并 / 删除'}
                    onClick={() => toggle(row.name)}
                  >
                    {on ? <IconCheck width={13} height={13} /> : null}
                  </button>
                  <button
                    type="button"
                    className="tx-tag-name"
                    title={reason ? `${row.name}｜${reason}` : `在书库里查看「${row.name}」`}
                    onClick={() => navigate({ name: 'library', tag: row.name })}
                  >
                    {row.name}
                  </button>
                  <span className="tx-tag-count">{row.count}</span>
                </div>
              )
                  })}
                </div>
              </section>
            ))}
        </>
      )}

    </div>
  )
}
