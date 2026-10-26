import io, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

P = r"D:\bookopen\src\renderer\src\components\MetadataEditor.tsx"
c = open(P, encoding="utf-8").read()
orig = c

c = c.replace(
    "import type { Book, EditResult, MetadataPatch } from '../../../shared/types'",
    "import type { Book, EditResult, MetadataPatch, WebMetaHit } from '../../../shared/types'",
)

c = c.replace(
    "  const [saving, setSaving] = useState(false)\n",
    "  const [saving, setSaving] = useState(false)\n"
    "  const [webQuery, setWebQuery] = useState(book.title)\n"
    "  const [hits, setHits] = useState<WebMetaHit[]>([])\n"
    "  const [looking, setLooking] = useState(false)\n"
    "  const [lookError, setLookError] = useState('')\n",
)

lookup = """  /** 全网查找：书名或 ISBN，豆瓣 + NeoDB 一起搜 */
  const webLookup = async (): Promise<void> => {
    const q = webQuery.trim()
    if (!q) {
      setLookError('先填书名或 ISBN')
      return
    }
    setLooking(true)
    setLookError('')
    try {
      const list = await window.api.invoke<WebMetaHit[]>(CH.metaSearch, q)
      const arr = Array.isArray(list) ? list : []
      setHits(arr)
      if (arr.length === 0) setLookError('没搜到')
    } catch (e) {
      setLookError(String(e))
    } finally {
      setLooking(false)
    }
  }

  /** 把一条结果填进表单，不立刻写库 */
  const fillFrom = (h: WebMetaHit): void => {
    setDraft((d) => ({
      ...d,
      title: h.title || d.title,
      authors: h.authors || d.authors,
      publisher: h.publisher || d.publisher,
      pubdate: h.pubdate || d.pubdate,
      languages: h.language || d.languages,
      comments: h.summary || d.comments
    }))
    setHits([])
  }

  const save = async (): Promise<void> => {
"""
c = c.replace("  const save = async (): Promise<void> => {\n", lookup, 1)

panel = """      <div className="me-web">
        <input
          className="input"
          value={webQuery}
          placeholder="书名或 ISBN"
          onChange={(e) => setWebQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void webLookup()
          }}
        />
        <button className="btn btn-sm" disabled={looking} onClick={() => void webLookup()}>
          {looking ? '查找中' : '全网查找'}
        </button>
        {lookError ? <em className="me-err">{lookError}</em> : null}
      </div>

      {hits.length > 0 ? (
        <div className="me-hits">
          {hits.map((h) => (
            <button
              type="button"
              key={`${h.source}-${h.id}`}
              className="me-hit"
              onClick={() => fillFrom(h)}
              title="填入表单，不会立刻写库"
            >
              {h.coverUrl ? (
                <img src={h.coverUrl} alt="" width={48} height={64} />
              ) : (
                <span className="me-hit-noimg" />
              )}
              <span className="me-hit-body">
                <span className="me-hit-title">{h.title}</span>
                <span className="me-hit-sub">{h.authors}</span>
                <span className="me-hit-sub">{[h.publisher, h.pubdate].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="me-hit-side">
                <span className="me-hit-src">{h.sourceName}</span>
                {h.coverWidth && h.coverHeight ? (
                  <span className="me-hit-res">
                    {h.coverWidth}x{h.coverHeight}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="me-grid">
"""
assert '<div className="me-grid">' in c
c = c.replace('      <div className="me-grid">', panel, 1)

if c == orig:
    print("NO CHANGE")
else:
    open(P, "w", encoding="utf-8", newline="\n").write(c)
    print("MetadataEditor 已更新")
