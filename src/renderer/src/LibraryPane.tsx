import { useMemo, useState } from 'react'
import type { Paper } from './types'

interface Props {
  papers: Paper[]
  activeId: number | null
  q: string
  onSetQ: (q: string) => void
  onOpen: (p: Paper) => void
  onCycleStatus: (p: Paper) => void
  onAddPapers: () => void
  onReindex: () => void
  onReclassify: () => void
  onBack: () => void
  onFwd: () => void
  canBack: boolean
  canFwd: boolean
  onOpenPalette: () => void
  mode: 'read' | 'chat'
  onModeChange: (m: 'read' | 'chat') => void
  width: number
}

export default function LibraryPane({
  papers,
  activeId,
  q,
  onSetQ,
  onOpen,
  onCycleStatus,
  onAddPapers,
  onReindex,
  onReclassify,
  onBack,
  onFwd,
  canBack,
  canFwd,
  onOpenPalette,
  mode,
  onModeChange,
  width
}: Props): JSX.Element {
  const cats = useMemo(() => {
    const m = new Map<string, Paper[]>()
    for (const p of papers) {
      if (!m.has(p.category)) m.set(p.category, [])
      m.get(p.category)!.push(p)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [papers])

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (c: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(c)) n.delete(c)
      else n.add(c)
      return n
    })

  const kw = q.trim().toLowerCase()
  const match = (p: Paper): boolean => !kw || p.title.toLowerCase().includes(kw) || p.authors.toLowerCase().includes(kw) || p.slug.includes(kw)
  const searching = kw.length > 0

  const navBtn = (dir: 'back' | 'fwd'): JSX.Element => (
    <button className="icon-btn" disabled={dir === 'back' ? !canBack : !canFwd} title={dir === 'back' ? '上一篇' : '下一篇'} onClick={dir === 'back' ? onBack : onFwd}>
      {dir === 'back' ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      )}
    </button>
  )

  const paperRow = (p: Paper): JSX.Element => (
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
  )

  return (
    <div className="library" style={{ width }}>
      <div className="lib-func">
        {/* 阅读 / 对话 模式切换（Kimi Workspace 式分段控件） */}
        <div className="mode-toggle">
          <button className={mode === 'read' ? 'on' : ''} onClick={() => onModeChange('read')} title="论文阅读（PDF + 翻译 + 问答）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 6c-1.8-1.6-4.2-2-8-2v14c3.8 0 6.2.4 8 2 1.8-1.6 4.2-2 8-2V4c-3.8 0-6.2.4-8 2z" />
              <path d="M12 6v14" />
            </svg>
            阅读
          </button>
          <button className={mode === 'chat' ? 'on' : ''} onClick={() => onModeChange('chat')} title="与全库文献对话（RAG）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a8 8 0 0 1-8 8H4l2.2-2.6A8 8 0 1 1 21 12z" />
            </svg>
            对话
          </button>
        </div>
        <div className="nav-row">
          {navBtn('back')}
          {navBtn('fwd')}
          <span className="nav-label">文献</span>
          <span style={{ flex: 1 }} />
          <span className="cat-count">{papers.length}</span>
        </div>
        <button className="add-btn" onClick={onAddPapers} title="导入 PDF，AI 自动归类；也可拖入窗口">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          添加文献
        </button>
        <div className="search-wrap">
          <input className="searchbox" placeholder="搜索" value={q} onChange={(e) => onSetQ(e.target.value)} />
          <button className="kbd-hint" title="命令面板（搜索文献 / 执行命令）" onClick={onOpenPalette}>
            {/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}
          </button>
        </div>
        <div className="func-row">
          <button className="mini-btn" onClick={onReindex} title="清空并重建全库索引">
            重建索引
          </button>
          <button className="mini-btn" onClick={onReclassify} title="AI 重新归类全部文献">
            AI 归类
          </button>
        </div>
      </div>
      <div className="lib-files">
        {searching
          ? papers.filter(match).map(paperRow)
          : cats.map(([c, list]) => (
              <div key={c}>
                <div className="cat-item" onClick={() => toggle(c)}>
                  <svg
                    className={`chev ${expanded.has(c) ? 'open' : ''}`}
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                  <span className="ellipsis" style={{ flex: 1 }}>
                    {c}
                  </span>
                  <span className="cat-count">{list.length}</span>
                </div>
                {expanded.has(c) && <div className="tree-papers">{list.map(paperRow)}</div>}
              </div>
            ))}
      </div>
    </div>
  )
}
