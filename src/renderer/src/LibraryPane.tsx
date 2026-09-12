import { useMemo } from 'react'
import type { Paper } from './types'

interface Props {
  papers: Paper[]
  activeId: number | null
  q: string
  onSetQ: (q: string) => void
  cat: string
  onSetCat: (c: string) => void
  onOpen: (p: Paper) => void
  onCycleStatus: (p: Paper) => void
  onAddPapers: () => void
  onReindex: () => void
  onReclassify: () => void
}

export default function LibraryPane({
  papers,
  activeId,
  q,
  onSetQ,
  cat,
  onSetCat,
  onOpen,
  onCycleStatus,
  onAddPapers,
  onReindex,
  onReclassify
}: Props): JSX.Element {
  const cats = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of papers) m.set(p.category, (m.get(p.category) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [papers])

  const kw = q.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      papers.filter(
        (p) =>
          (cat === '__all' || p.category === cat) &&
          (!kw || p.title.toLowerCase().includes(kw) || p.authors.toLowerCase().includes(kw) || p.slug.includes(kw))
      ),
    [papers, cat, kw]
  )

  return (
    <div className="library">
      {/* 上半部分：功能区 */}
      <div className="lib-func">
        <button className="add-btn" onClick={onAddPapers} title="选择 PDF 导入，AI 自动归类；也可直接拖入窗口">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          添加文献
        </button>
        <input className="searchbox" placeholder="搜索标题 / 作者" value={q} onChange={(e) => onSetQ(e.target.value)} />
        <div className="func-row">
          <button className="mini-btn" onClick={onReindex} title="清空并重建全库向量索引">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" />
            </svg>
            重建索引
          </button>
          <button className="mini-btn" onClick={onReclassify} title="AI 重新归类全部文献，可创建新分类">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2H2v10l9.3 9.3a1.7 1.7 0 0 0 2.4 0l7.6-7.6a1.7 1.7 0 0 0 0-2.4L12 2z" />
              <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
            </svg>
            AI 归类
          </button>
        </div>
      </div>
      {/* 下半部分：文件区（标签 + 论文） */}
      <div className="lib-files">
        <div className="cat-list">
          <div className={`cat-item ${cat === '__all' ? 'active' : ''}`} onClick={() => onSetCat('__all')}>
            <span>全部</span>
            <span className="cat-count">{papers.length}</span>
          </div>
          {cats.map(([c, n]) => (
            <div key={c} className={`cat-item ${cat === c ? 'active' : ''}`} onClick={() => onSetCat(c)} title={`${c} · ${n} 篇`}>
              <span>{c}</span>
              <span className="cat-count">{n}</span>
            </div>
          ))}
        </div>
        <div className="paper-list">
          {filtered.map((p) => (
            <div
              key={p.id}
              className={`paper-item ${p.id === activeId ? 'active' : ''}`}
              onClick={() => onOpen(p)}
              onContextMenu={(e) => {
                e.preventDefault()
                window.api.paperMenu(p.id, e.clientX, e.clientY)
              }}
            >
              <div className="t">{p.title}</div>
              <div className="m">
                <span
                  className={`status-dot status-${p.status}`}
                  title={`${p.status}（点击切换）`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onCycleStatus(p)
                  }}
                />
                <span>{p.year ?? '—'}</span>
                <span className="cat">{p.category}</span>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: 20, color: 'var(--text-dim)', textAlign: 'center' }}>没有匹配的文献</div>}
        </div>
      </div>
    </div>
  )
}
