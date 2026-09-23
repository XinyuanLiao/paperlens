import { useEffect, useMemo, useState } from 'react'
import type { ChatMeta, Paper } from './types'

interface Props {
  papers: Paper[]
  cats: string[]
  activeId: number | null
  q: string
  onSetQ: (q: string) => void
  onOpen: (p: Paper) => void
  onCycleStatus: (p: Paper) => void
  onAddPapers: () => void
  onNewChat: () => void
  // 勾选文献 → 加入对话检索范围
  onAddPicks: (ps: Paper[]) => void
  // 对话模式：历史会话列表与当前会话
  chats: ChatMeta[]
  curChatId: number | null
  onOpenChat: (id: number) => void
  onDeleteChat: (id: number) => void
  onRenameChat: (id: number, title: string) => void
  onMovePaper: (id: number, cat: string) => void
  onReindex: () => void
  onOpenPalette: () => void
  mode: 'read' | 'chat'
  onModeChange: (m: 'read' | 'chat') => void
  width: number
  onPapersChanged: () => void
}

// sqlite datetime('now') 是 UTC 无时区后缀，补 Z 再解析
const relTime = (s?: string | null): string => {
  if (!s) return ''
  const d = new Date(s.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return ''
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 172800) return '昨天'
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`
  return d.toISOString().slice(0, 10)
}

// 分类显示名：inbox 是「未分类」的内部目录名，界面上统一显示中文
export const catLabel = (c: string): string => (c === 'inbox' ? '未分类' : c)

export default function LibraryPane({
  papers,
  cats,
  activeId,
  q,
  onSetQ,
  onOpen,
  onCycleStatus,
  onAddPapers,
  onNewChat,
  onAddPicks,
  chats,
  curChatId,
  onOpenChat,
  onDeleteChat,
  onRenameChat,
  onMovePaper,
  onReindex,
  onOpenPalette,
  mode,
  onModeChange,
  width,
  onPapersChanged
}: Props): JSX.Element {
  const tree = useMemo(() => {
    // 分类树 = 数据库分类列表（含空分类）+ 兜底（行里有但列表漏掉的）
    const m = new Map<string, Paper[]>(cats.map((c) => [c, []]))
    for (const p of papers) {
      if (!m.has(p.category)) m.set(p.category, [])
      m.get(p.category)!.push(p)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [papers, cats])

  // 最近：最近打开优先，没打开过的按导入时间（新导入的自然置顶）
  const recent = useMemo(
    () =>
      [...papers]
        .sort((a, b) => (b.opened_at ?? b.added_at).localeCompare(a.opened_at ?? a.added_at))
        .slice(0, 60),
    [papers]
  )

  const [view, setView] = useState<'recent' | 'cats'>('recent')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (c: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(c)) n.delete(c)
      else n.add(c)
      return n
    })

  // 勾选文献（加入对话检索范围用）：切到对话模式不丢，加入后保留（便于回阅读模式增删重选）
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const togglePick = (id: number): void =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const allPicked = papers.length > 0 && papers.every((p) => picked.has(p.id))
  const toggleAll = (): void => setPicked(allPicked ? new Set() : new Set(papers.map((p) => p.id)))
  // 分类头全选：全在选则清掉，否则补齐
  const toggleCat = (list: Paper[]): void =>
    setPicked((s) => {
      const n = new Set(s)
      const all = list.every((p) => n.has(p.id))
      for (const p of list) {
        if (all) n.delete(p.id)
        else n.add(p.id)
      }
      return n
    })

  const kw = q.trim().toLowerCase()
  const match = (p: Paper): boolean => !kw || p.title.toLowerCase().includes(kw) || p.authors.toLowerCase().includes(kw) || p.slug.includes(kw)
  const searching = kw.length > 0

  // 拖拽移动文献：拖到分类头放下
  const [dragCat, setDragCat] = useState<string | null>(null)
  const onRowDragStart = (e: React.DragEvent, p: Paper): void => {
    e.dataTransfer.setData('text/plain', `paper:${p.id}`)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onCatDrop = (e: React.DragEvent, c: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragCat(null)
    const raw = e.dataTransfer.getData('text/plain')
    const id = raw.startsWith('paper:') ? parseInt(raw.slice(6)) : NaN
    if (!isNaN(id)) onMovePaper(id, c)
  }

  // ---------- 弹窗：重命名 / 新建分类 / 移入新分类 / 重命名文献 ----------
  const [renameCat, setRenameCat] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [renaming, setRenaming] = useState(false)
  useEffect(() => window.api.onCategoryRenameRequest((cat) => {
    setRenameCat(cat)
    setRenameVal(cat)
  }), [])

  const [renamePaper, setRenamePaper] = useState<{ id: number; title: string } | null>(null)
  const [renamePaperVal, setRenamePaperVal] = useState('')
  const [renamingPaper, setRenamingPaper] = useState(false)
  useEffect(() => window.api.onPapersRenameRequest(({ id, title }) => {
    setRenamePaper({ id, title })
    setRenamePaperVal(title)
  }), [])

  const doRenamePaper = async (): Promise<void> => {
    if (!renamePaper || !renamePaperVal.trim() || renamingPaper) return
    setRenamingPaper(true)
    try {
      await window.api.renamePaper(renamePaper.id, renamePaperVal.trim())
      setRenamePaper(null)
      onPapersChanged()
    } catch (e) {
      alert(String(e))
    } finally {
      setRenamingPaper(false)
    }
  }

  // 历史对话重命名（右键触发）
  const [renameChat, setRenameChat] = useState<ChatMeta | null>(null)
  const [renameChatVal, setRenameChatVal] = useState('')
  const [renamingChat, setRenamingChat] = useState(false)
  const doRenameChat = async (): Promise<void> => {
    if (!renameChat || !renameChatVal.trim() || renamingChat) return
    setRenamingChat(true)
    try {
      onRenameChat(renameChat.id, renameChatVal.trim())
      setRenameChat(null)
    } catch (e) {
      alert(String(e))
    } finally {
      setRenamingChat(false)
    }
  }

  // 对话模式：搜索框过滤历史对话标题
  const chatKw = q.trim().toLowerCase()
  const chatFiltered = useMemo(
    () => (chatKw ? chats.filter((c) => c.title.toLowerCase().includes(chatKw)) : chats),
    [chats, chatKw]
  )

  const [newCat, setNewCat] = useState<null | { paper?: Paper }>(null) // paper 存在 = 移动这篇并新建
  const [newCatVal, setNewCatVal] = useState('')
  const [creating, setCreating] = useState(false)
  useEffect(() => window.api.onCategoryCreateRequest(() => {
    setNewCat({})
    setNewCatVal('')
  }), [])
  useEffect(() => window.api.onMoveNewRequest(({ id }) => {
    const p = papers.find((x) => x.id === id)
    setNewCat({ paper: p })
    setNewCatVal('')
  }), [papers])

  const doRename = async (): Promise<void> => {
    if (!renameCat || !renameVal.trim() || renaming) return
    setRenaming(true)
    try {
      await window.api.renameCategory(renameCat, renameVal.trim())
      setRenameCat(null)
      onPapersChanged()
    } catch (e) {
      alert(String(e))
    } finally {
      setRenaming(false)
    }
  }
  const doCreateCat = async (): Promise<void> => {
    const name = newCatVal.trim()
    if (!newCat || !name || creating) return
    setCreating(true)
    try {
      if (newCat.paper) await window.api.movePaper(newCat.paper.id, name)
      else await window.api.createCategory(name)
      setNewCat(null)
      onPapersChanged()
    } catch (e) {
      alert(String(e))
    } finally {
      setCreating(false)
    }
  }

  const paperRow = (p: Paper, extra?: React.ReactNode): JSX.Element => (
    <div
      key={p.id}
      className={`paper-item ${p.id === activeId ? 'active' : ''}`}
      draggable
      onDragStart={(e) => onRowDragStart(e, p)}
      onClick={() => onOpen(p)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        window.api.paperMenu(p.id, e.clientX, e.clientY)
      }}
      title="拖到分类上可移动；右键更多操作"
    >
      <div className="t">
        <span
          className={`pick-box ${picked.has(p.id) ? 'on' : ''}`}
          title="勾选后可加入对话检索范围"
          onClick={(e) => {
            e.stopPropagation()
            togglePick(p.id)
          }}
        >
          ✓
        </span>
        <span className="pick-title">{p.title}</span>
      </div>
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
        {extra ?? <span className="cat">{catLabel(p.category)}</span>}
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
        {mode === 'read' ? (
          <button className="add-btn" onClick={onAddPapers} title="导入 PDF，AI 自动归类；也可拖入窗口">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            添加文献
          </button>
        ) : (
          <>
            <div className="nav-row">
              <span className="nav-label">对话</span>
              <span style={{ flex: 1 }} />
              <span className="cat-count">{chats.length}</span>
            </div>
            <button className="add-btn" onClick={onNewChat} title="当前对话自动存入历史；开始新的全库对话">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              新建对话
            </button>
          </>
        )}
        <div className="search-wrap">
          <input
            className="searchbox"
            placeholder={mode === 'chat' ? '搜索对话' : '搜索'}
            value={q}
            onChange={(e) => onSetQ(e.target.value)}
          />
          <button className="kbd-hint" title="命令面板（搜索文献 / 执行命令）" onClick={onOpenPalette}>
            {/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}
          </button>
        </div>
        {mode === 'read' && (
          <div className="func-row">
            <button className="mini-btn" onClick={onReindex} title="清空并重建全库索引">
              重建索引
            </button>
          </div>
        )}
      </div>
      <div className="lib-files">
        {/* 对话模式：文件区整个变为历史对话列表 */}
        {mode === 'chat' ? (
          <div className="lib-files-scroll">
            <div className="lib-section">历史对话 · {chatFiltered.length}</div>
            {chatFiltered.map((c) => (
              <div
                key={c.id}
                className={`chat-item ${c.id === curChatId ? 'active' : ''}`}
                onClick={() => onOpenChat(c.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setRenameChat(c)
                  setRenameChatVal(c.title)
                }}
                title="点击继续该对话；右键重命名"
              >
                <div className="t ellipsis">{c.title}</div>
                <div className="m">
                  <span>{relTime(c.updated_at)}</span>
                  <span>{c.n} 条</span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="chat-x"
                    title="删除该对话"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteChat(c.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            {chatFiltered.length === 0 && (
              <div className="tree-empty">{chatKw ? '没有匹配的对话' : '还没有历史对话；提问后自动保存，点上方「新建对话」可开启新话题'}</div>
            )}
          </div>
        ) : (
          <>
        {/* 文件区子标签：不透明背景，滚动内容不会从后面穿过去 */}
        {!searching && (
          <div className="lib-view-toggle">
            <div className="lib-view-seg">
              <button className={view === 'recent' ? 'on' : ''} onClick={() => setView('recent')} title="最近导入 / 最近打开">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="8.5" />
                  <path d="M12 7.5V12l3 2" />
                </svg>
                最近
              </button>
              <button className={view === 'cats' ? 'on' : ''} onClick={() => setView('cats')} title="按分类浏览">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                分类
              </button>
            </div>
            <span style={{ flex: 1 }} />
            <button
              className="lib-newcat"
              title={allPicked ? '取消全库勾选' : '全选本库全部文献'}
              onClick={toggleAll}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.8" />
                {allPicked && <path d="M5 8.2 7 10.2 11 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
              </svg>
              {allPicked ? '取消全选' : '全选'}
            </button>
            <button className="lib-newcat" title="新建分类" onClick={() => { setNewCat({}); setNewCatVal('') }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              新建分类
            </button>
          </div>
        )}
        <div
          className="lib-files-scroll"
          onContextMenu={(e) => {
            e.preventDefault()
            window.api.blankMenu(e.clientX, e.clientY)
          }}
        >
          {searching ? (
            <>
              <div className="lib-section">搜索结果 · {papers.filter(match).length}</div>
              {papers.filter(match).map((p) => paperRow(p))}
            </>
          ) : view === 'recent' ? (
            <>
              <div className="lib-section">最近导入 / 打开</div>
              {recent.map((p) =>
                paperRow(
                  p,
                  <>
                    <span className="cat">{catLabel(p.category)}</span>
                    <span title={`导入 ${p.added_at.slice(0, 10)}${p.opened_at ? ` · 打开 ${p.opened_at.slice(0, 10)}` : ''}`}>
                      {p.opened_at ? relTime(p.opened_at) : relTime(p.added_at)}
                    </span>
                  </>
                )
              )}
            </>
          ) : (
            tree.map(([c, list]) => (
              <div key={c}>
                <div
                  className={`cat-item ${dragCat === c ? 'drop-on' : ''}`}
                  onClick={() => toggle(c)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    window.api.categoryMenu(c, e.clientX, e.clientY)
                  }}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('text/plain')) {
                      e.preventDefault()
                      e.stopPropagation()
                      setDragCat(c)
                    }
                  }}
                  onDragLeave={() => setDragCat((d) => (d === c ? null : d))}
                  onDrop={(e) => onCatDrop(e, c)}
                  title="点击展开 / 收起；右键重命名、导出；拖文献到此移动"
                >
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
                    {catLabel(c)}
                  </span>
                  <span
                    className={`cat-pick ${list.length > 0 && list.every((p) => picked.has(p.id)) ? 'on' : ''}`}
                    title={list.every((p) => picked.has(p.id)) ? '取消该分类勾选' : '全选该分类'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleCat(list)
                    }}
                  >
                    全选
                  </span>
                  <span className="cat-count">{list.length}</span>
                </div>
                {expanded.has(c) && (
                  <div className="tree-papers">
                    {list.map((p) => paperRow(p))}
                    {list.length === 0 && <div className="tree-empty">空分类，右键可删除；拖文献进来或导入时 AI 归类</div>}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
          </>
        )}
        {/* 阅读模式底部：勾选的文献一键加入对话检索范围（无勾选 = 灰置） */}
        {mode === 'read' && (
          <div className="pick-foot">
            <button
              className="pick-btn"
              disabled={picked.size === 0}
              onClick={() => onAddPicks(papers.filter((p) => picked.has(p.id)))}
            >
              加入对话检索{picked.size > 0 ? ` · ${picked.size} 篇` : ''}
            </button>
          </div>
        )}
      </div>

      {renameCat && (
        <div className="modal-mask" onMouseDown={() => setRenameCat(null)}>
          <div className="modal modal-pad" style={{ width: 440 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>重命名分类</h2>
              <button className="modal-x" title="取消" onClick={() => setRenameCat(null)}>
                ✕
              </button>
            </div>
            <div className="field">
              <label>新名称（小写字母 / 数字 / 连字符）</label>
              <input
                autoFocus
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doRename()
                }}
              />
              <div className="hint">分类文件夹将改名并入，论文的阅读状态与高亮保持不变。</div>
            </div>
            <div className="modal-actions">
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={() => setRenameCat(null)}>
                取消
              </button>
              <button className="btn" onClick={() => void doRename()} disabled={renaming}>
                确认重命名
              </button>
            </div>
          </div>
        </div>
      )}

      {renamePaper && (
        <div className="modal-mask" onMouseDown={() => setRenamePaper(null)}>
          <div className="modal modal-pad" style={{ width: 460 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>重命名文献</h2>
              <button className="modal-x" title="取消" onClick={() => setRenamePaper(null)}>
                ✕
              </button>
            </div>
            <div className="field">
              <label>标题</label>
              <input
                autoFocus
                value={renamePaperVal}
                onChange={(e) => setRenamePaperVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doRenamePaper()
                }}
              />
              <div className="hint">只改显示标题与检索信息，PDF 文件与阅读进度、高亮不受影响。</div>
            </div>
            <div className="modal-actions">
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={() => setRenamePaper(null)}>
                取消
              </button>
              <button className="btn" onClick={() => void doRenamePaper()} disabled={renamingPaper || !renamePaperVal.trim()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {newCat && (
        <div className="modal-mask" onMouseDown={() => setNewCat(null)}>
          <div className="modal modal-pad" style={{ width: 440 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{newCat.paper ? '新建分类并移入' : '新建分类'}</h2>
              <button className="modal-x" title="取消" onClick={() => setNewCat(null)}>
                ✕
              </button>
            </div>
            <div className="field">
              <label>{newCat.paper ? `分类名（将把《${newCat.paper.title.slice(0, 40)}…》移入）` : '分类名（可用中文）'}</label>
              <input
                autoFocus
                value={newCatVal}
                onChange={(e) => setNewCatVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doCreateCat()
                }}
              />
              <div className="hint">新建后可在导入归类、右键移动与拖拽中使用；空分类可右键删除。</div>
            </div>
            <div className="modal-actions">
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={() => setNewCat(null)}>
                取消
              </button>
              <button className="btn" onClick={() => void doCreateCat()} disabled={creating || !newCatVal.trim()}>
                {newCat.paper ? '移入' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {renameChat && (
        <div className="modal-mask" onMouseDown={() => setRenameChat(null)}>
          <div className="modal modal-pad" style={{ width: 440 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>重命名对话</h2>
              <button className="modal-x" title="取消" onClick={() => setRenameChat(null)}>
                ✕
              </button>
            </div>
            <div className="field">
              <label>话题名称</label>
              <input
                autoFocus
                value={renameChatVal}
                onChange={(e) => setRenameChatVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doRenameChat()
                }}
              />
              <div className="hint">只改列表里显示的名字，对话内容不受影响。</div>
            </div>
            <div className="modal-actions">
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={() => setRenameChat(null)}>
                取消
              </button>
              <button className="btn" onClick={() => void doRenameChat()} disabled={renamingChat || !renameChatVal.trim()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
