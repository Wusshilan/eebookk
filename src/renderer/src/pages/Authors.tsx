import { useCallback, useEffect, useMemo, useState } from 'react'
import { CH } from '../../../shared/ipc'
import type { Book, TaxonomyRow, TaxonomySummary } from '../../../shared/types'
import { useApp } from '../app/context'
import { useTaxonomyProgress } from '../lib/useTaxonomyProgress'
import { coverUrl } from '../lib/cover'
import { IconRefresh } from '../icons'

/** 主进程 taxonomy.ts 返回的结构；shared 里没有这个类型，也不允许改 shared，这里本地声明 */
interface TaxonomyEditResult {
  ok: boolean
  updated: number
  failed: { id: number; title: string; error: string }[]
  message?: string
}

function splitAuthors(authors: string): string[] {
  if (!authors) return []
  return authors
    .split('&')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 常见中文姓氏 → 拼音首字母。
 * 本机没有拼音库，也不允许加依赖，所以用一个常见姓氏表做首字母分组；
 * 表里没有的字（译名、日文名、生僻姓）统一归到「其他」，比乱猜准确。
 */
const SURNAME_INITIAL: Record<string, string> = {
  '安': 'A', '艾': 'A', '敖': 'A', '阿': 'A',
  '白': 'B', '包': 'B', '鲍': 'B', '毕': 'B', '卞': 'B', '边': 'B', '卜': 'B', '柏': 'B',
  '班': 'B', '贝': 'B', '别': 'B', '邴': 'B',
  '陈': 'C', '曹': 'C', '蔡': 'C', '崔': 'C', '程': 'C', '常': 'C', '车': 'C', '池': 'C',
  '褚': 'C', '岑': 'C', '柴': 'C', '储': 'C', '楚': 'C', '丛': 'C', '迟': 'C', '昌': 'C',
  '成': 'C', '晁': 'C', '巢': 'C', '谌': 'C',
  '邓': 'D', '董': 'D', '杜': 'D', '丁': 'D', '戴': 'D', '段': 'D', '党': 'D', '窦': 'D',
  '刁': 'D', '狄': 'D', '邸': 'D', '东': 'D', '都': 'D', '堵': 'D', '端': 'D', '独': 'D',
  '冯': 'F', '范': 'F', '付': 'F', '方': 'F', '樊': 'F', '费': 'F', '符': 'F', '房': 'F',
  '封': 'F', '伏': 'F', '傅': 'F', '富': 'F', '丰': 'F',
  '郭': 'G', '高': 'G', '龚': 'G', '顾': 'G', '耿': 'G', '甘': 'G', '葛': 'G', '巩': 'G',
  '谷': 'G', '官': 'G', '关': 'G', '管': 'G', '桂': 'G', '古': 'G', '苟': 'G', '盖': 'G',
  '公': 'G', '宫': 'G',
  '黄': 'H', '胡': 'H', '何': 'H', '韩': 'H', '侯': 'H', '贺': 'H', '郝': 'H', '洪': 'H',
  '华': 'H', '霍': 'H', '惠': 'H', '和': 'H', '杭': 'H', '花': 'H', '怀': 'H', '皇': 'H',
  '蒋': 'J', '姜': 'J', '贾': 'J', '江': 'J', '金': 'J', '季': 'J', '姬': 'J', '吉': 'J',
  '纪': 'J', '简': 'J', '焦': 'J', '靳': 'J', '景': 'J', '鞠': 'J', '荆': 'J', '冀': 'J',
  '井': 'J',
  '孔': 'K', '康': 'K', '柯': 'K', '寇': 'K', '匡': 'K', '邝': 'K', '阚': 'K', '亢': 'K',
  '李': 'L', '刘': 'L', '林': 'L', '罗': 'L', '梁': 'L', '吕': 'L', '卢': 'L', '陆': 'L',
  '廖': 'L', '雷': 'L', '龙': 'L', '黎': 'L', '赖': 'L', '蓝': 'L', '郎': 'L', '娄': 'L',
  '路': 'L', '骆': 'L', '柳': 'L', '鲁': 'L', '冷': 'L', '连': 'L', '芦': 'L', '楼': 'L',
  '蔺': 'L', '厉': 'L', '劳': 'L', '廉': 'L', '凌': 'L', '令': 'L',
  '马': 'M', '毛': 'M', '孟': 'M', '莫': 'M', '苗': 'M', '米': 'M', '闵': 'M', '穆': 'M',
  '蒙': 'M', '缪': 'M', '麦': 'M', '牟': 'M', '明': 'M', '麻': 'M', '满': 'M', '梅': 'M',
  '慕': 'M',
  '牛': 'N', '倪': 'N', '聂': 'N', '宁': 'N', '南': 'N', '农': 'N', '那': 'N',
  '欧': 'O',
  '彭': 'P', '潘': 'P', '庞': 'P', '裴': 'P', '蒲': 'P', '皮': 'P', '平': 'P', '濮': 'P',
  '钱': 'Q', '秦': 'Q', '邱': 'Q', '覃': 'Q', '齐': 'Q', '乔': 'Q', '屈': 'Q', '祁': 'Q',
  '戚': 'Q', '瞿': 'Q', '全': 'Q', '仇': 'Q', '强': 'Q', '曲': 'Q', '钦': 'Q', '裘': 'Q',
  '任': 'R', '阮': 'R', '冉': 'R', '饶': 'R', '荣': 'R',
  '孙': 'S', '宋': 'S', '苏': 'S', '沈': 'S', '石': 'S', '史': 'S', '施': 'S', '邵': 'S',
  '盛': 'S', '舒': 'S', '单': 'S', '司': 'S', '时': 'S', '尚': 'S', '申': 'S', '师': 'S',
  '沙': 'S', '桑': 'S', '隋': 'S', '商': 'S', '佘': 'S', '水': 'S', '松': 'S', '宿': 'S',
  '束': 'S', '帅': 'S',
  '唐': 'T', '田': 'T', '谭': 'T', '陶': 'T', '汤': 'T', '童': 'T', '涂': 'T', '滕': 'T',
  '佟': 'T', '谈': 'T', '屠': 'T',
  '王': 'W', '吴': 'W', '魏': 'W', '汪': 'W', '韦': 'W', '万': 'W', '武': 'W', '温': 'W',
  '文': 'W', '伍': 'W', '巫': 'W', '翁': 'W', '卫': 'W', '邬': 'W', '闻': 'W', '危': 'W',
  '隗': 'W',
  '徐': 'X', '谢': 'X', '许': 'X', '肖': 'X', '薛': 'X', '夏': 'X', '熊': 'X', '邢': 'X',
  '席': 'X', '项': 'X', '辛': 'X', '解': 'X', '奚': 'X', '冼': 'X', '轩': 'X', '幸': 'X',
  '杨': 'Y', '袁': 'Y', '于': 'Y', '余': 'Y', '叶': 'Y', '姚': 'Y', '尹': 'Y', '闫': 'Y',
  '严': 'Y', '颜': 'Y', '易': 'Y', '岳': 'Y', '殷': 'Y', '俞': 'Y', '喻': 'Y', '应': 'Y',
  '郁': 'Y', '伊': 'Y', '元': 'Y', '尤': 'Y', '阳': 'Y', '晏': 'Y', '苑': 'Y', '燕': 'Y',
  '乐': 'Y', '尉': 'Y', '宇': 'Y', '游': 'Y', '虞': 'Y', '庾': 'Y',
  '张': 'Z', '赵': 'Z', '周': 'Z', '朱': 'Z', '郑': 'Z', '钟': 'Z', '邹': 'Z', '曾': 'Z',
  '詹': 'Z', '庄': 'Z', '章': 'Z', '翟': 'Z', '祝': 'Z', '仲': 'Z', '宗': 'Z', '卓': 'Z',
  '左': 'Z', '甄': 'Z', '查': 'Z', '诸': 'Z', '昝': 'Z', '臧': 'Z', '支': 'Z'
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const GROUP_ORDER = [...LETTERS, '#', '其他']

function initialOf(name: string): string {
  const first = name.trim().charAt(0)
  if (!first) return '其他'
  if (/[A-Za-z]/.test(first)) return first.toUpperCase()
  if (/[0-9]/.test(first)) return '#'
  return SURNAME_INITIAL[first] ?? '其他'
}

const CSS = `
.tx-au-wrap {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
}
.tx-au-rail {
  position: sticky;
  top: 0;
  z-index: 6;
  flex: none;
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  display: flex;
  flex-direction: row;
  gap: 5px;
  padding: 7px 8px;
  border: 1px solid var(--hairline-soft);
  border-radius: 12px;
  background: var(--surface);
  scrollbar-width: none;
}
.tx-au-rail::-webkit-scrollbar {
  display: none;
}
.tx-au-rail-item {
  height: 30px;
  flex: none;
  padding: 0 11px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--t3);
  white-space: nowrap;
}
.tx-au-rail-item:hover {
  background: #efefef;
  color: var(--t1);
}
.tx-au-rail-item.is-active {
  background: var(--accent);
  color: #fff;
}
.tx-au-rail-item i {
  font-style: normal;
  font-size: 10.5px;
  color: var(--t2);
  font-variant-numeric: tabular-nums;
}
.tx-au-rail-item.is-active i {
  color: rgba(255, 255, 255, 0.82);
}
.tx-au-main-col {
  flex: 1;
  min-width: 0;
}
.tx-au-group {
  margin-bottom: 28px;
}
.tx-au-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 17px;
  font-weight: 600;
}
.tx-au-head span {
  font-size: 12px;
  font-weight: 400;
  color: var(--t2);
}
.tx-au-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px;
}
.tx-au-card {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 58px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--hairline-soft);
  border-radius: 12px;
  background: var(--surface);
  transition: border-color 0.14s ease, box-shadow 0.14s ease, background-color 0.14s ease;
}
.tx-au-card:hover {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: var(--shadow-1);
}
.tx-au-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
}
.tx-au-cover {
  width: 34px;
  height: 46px;
  flex: none;
  border-radius: 3px;
  object-fit: cover;
  display: block;
  background: var(--surface-2);
}
.tx-au-noimg {
  display: grid;
  place-items: center;
  font-size: 16px;
  font-weight: 600;
  color: #b9b9b9;
}
.tx-au-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tx-au-name {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tx-au-count {
  font-size: 12px;
  color: var(--t2);
}
.tx-au-rename {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--t3);
  background: var(--pill-grey);
  opacity: 0;
  transition: opacity 0.14s ease, background-color 0.14s ease;
}
.tx-au-card:hover .tx-au-rename {
  opacity: 1;
}
.tx-au-rename:hover:not(:disabled) {
  background: var(--accent-weak);
  color: var(--accent-press);
}
.tx-au-rename:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tx-lock-note {
  font-size: 12.5px;
  color: #b56a00;
  white-space: nowrap;
}
.tx-au-foot {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 10px;
}
`

export default function Authors(): React.ReactElement {
  const { books, navigate, invoke, reload, toast, calibreRunning, ask } = useApp()
  const progress = useTaxonomyProgress()

  const [summary, setSummary] = useState<TaxonomySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [sortKey, setSortKey] = useState<'count' | 'name'>('count')
  const [activeInitial, setActiveInitial] = useState('all')
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

  useEffect(() => {
    void load()
  }, [load, books.length])

  /** 每位作者取一本代表作：优先有封面的，否则取书库里第一本 */
  const reps = useMemo(() => {
    const map = new Map<string, Book>()
    for (const book of books) {
      for (const name of splitAuthors(book.authors)) {
        const cur = map.get(name)
        if (!cur || (!cur.hasCover && book.hasCover)) map.set(name, book)
      }
    }
    return map
  }, [books])

  const coveredBooks = useMemo(() => {
    const ids = new Set<number>()
    for (const author of summary?.authors ?? []) for (const id of author.bookIds) ids.add(id)
    return ids.size
  }, [summary])

  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    let list = summary?.authors ?? []
    if (kw) list = list.filter((author) => author.name.toLowerCase().includes(kw))
    const sorted = [...list]
    if (sortKey === 'count') {
      sorted.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    }
    return sorted
  }, [summary, keyword, sortKey])

  const groups = useMemo(() => {
    const map = new Map<string, TaxonomyRow[]>()
    for (const row of rows) {
      const key = initialOf(row.name)
      const bucket = map.get(key)
      if (bucket) bucket.push(row)
      else map.set(key, [row])
    }
    return [...map.entries()]
      .sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]))
      .map(([key, list]) => ({ key, rows: list }))
  }, [rows])

  const groupCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const key = initialOf(row.name)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [rows])

  // 搜索把当前字母组筛没了就自动回到「全部」，避免一片空白
  const effectiveInitial = activeInitial !== 'all' && groupCounts.has(activeInitial) ? activeInitial : 'all'
  const visibleGroups =
    effectiveInitial === 'all' ? groups : groups.filter((group) => group.key === effectiveInitial)

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
      await reload()
      await load()
    } catch (e) {
      toast(`${label}失败：${String(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const renameAuthor = async (row: TaxonomyRow): Promise<void> => {
    if (calibreRunning || busy) return
    const input = await ask({
      title: `把作者「${row.name}」改名为`,
      message: `该作者名下的 ${row.count} 本书会一起改写（只改元数据，不动书籍文件）。如果新名字已经是另一位作者，两边会合并。`,
      label: '新作者名',
      defaultValue: row.name,
      okText: '改名'
    })
    if (input == null) return
    const next = input.trim()
    if (!next || next === row.name) return
    void runEdit(`重命名作者「${row.name}」`, () =>
      invoke<TaxonomyEditResult>(CH.authorRename, row.name, next)
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
        <h1 className="page-title">作者</h1>
        <span className="page-sub">
          {summary
            ? `${summary.authors.length} 位作者 · ${coveredBooks} 本书有作者`
            : loading
              ? '正在聚合…'
              : '还没有读到作者'}
        </span>
        <span className="spacer" />
        {calibreRunning ? <span className="lock-pill">calibre 运行中 · 只读</span> : null}
        {calibreRunning ? <span className="tx-lock-note">改名已锁定，先退出 calibre</span> : null}
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
        <button className="btn btn-sm btn-ghost" disabled={loading} onClick={() => void load()}>
          <IconRefresh width={16} height={16} />
          刷新
        </button>
      </div>

      {!summary ? (
        <div className="empty">{loading ? '正在聚合作者…' : '读取失败，点右上角「刷新」重试'}</div>
      ) : summary.authors.length === 0 ? (
        <div className="empty">
          书库里还没有作者信息。
          <br />
          在 calibre 或书籍详情页补上作者后，这里会按拼音首字母列出每位作者和代表作封面。
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">没有匹配的作者，换个关键词试试。</div>
      ) : (
        <div className="tx-au-wrap">
          <div className="tx-au-rail">
            <button
              className={`tx-au-rail-item${effectiveInitial === 'all' ? ' is-active' : ''}`}
              onClick={() => setActiveInitial('all')}
              title="显示全部作者"
            >
              <span>全部</span>
              <i>{rows.length}</i>
            </button>
            {GROUP_ORDER.map((key) => {
              const count = groupCounts.get(key) ?? 0
              if (!count) return null
              return (
                <button
                  key={key}
                  className={`tx-au-rail-item${effectiveInitial === key ? ' is-active' : ''}`}
                  onClick={() => setActiveInitial(key)}
                  title={`只看 ${key} 组（${count} 位）`}
                >
                  <span>{key}</span>
                  <i>{count}</i>
                </button>
              )
            })}
          </div>

          <div className="tx-au-main-col">
            {visibleGroups.map((group) => (
              <section className="tx-au-group" key={group.key}>
                <h2 className="tx-au-head">
                  {group.key}
                  <span>{group.rows.length} 位作者</span>
                </h2>
                <div className="tx-au-grid">
                  {group.rows.map((row) => {
                    const rep = reps.get(row.name)
                    return (
                      <article className="tx-au-card" key={row.name}>
                        <button
                          type="button"
                          className="tx-au-main"
                          onClick={() => navigate({ name: 'library', author: row.name })}
                          title={
                            rep
                              ? `${row.name}｜代表作：《${rep.title}》`
                              : `在书库里查看「${row.name}」`
                          }
                        >
                          {rep && rep.hasCover ? (
                            <img
                              className="tx-au-cover"
                              src={coverUrl(rep.id)}
                              alt={rep.title}
                              loading="lazy"
                              draggable={false}
                            />
                          ) : (
                            <span className="tx-au-cover tx-au-noimg">{row.name.slice(0, 1)}</span>
                          )}
                          <span className="tx-au-meta">
                            <span className="tx-au-name">{row.name}</span>
                            <span className="tx-au-count">{row.count} 本</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="tx-au-rename"
                          disabled={calibreRunning || busy}
                          title={
                            calibreRunning
                              ? 'calibre 正在运行，关闭后才能改名'
                              : `把「${row.name}」改成别的名字`
                          }
                          onClick={() => void renameAuthor(row)}
                        >
                          改名
                        </button>
                      </article>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
