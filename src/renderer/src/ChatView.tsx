import { useEffect, useMemo, useRef, useState } from 'react'
import { renderRich, type Jump } from './rich'
import { buildSuggestions } from './suggest'
import { ModelPill, ThinkingToggle, ScopePill, type ChatScope } from './ChatControls'
import VerifyBar from './VerifyBar'
import type { ChatMsg, Paper, SourceRef, VerifyReport } from './types'

interface Props {
  papers: Paper[]
  paperCount: number
  cats: string[]
  catCounts: Map<string, number>
  scope: ChatScope
  onScopeChange: (s: ChatScope) => void
  models: string[]
  model: string
  thinkingOn: boolean
  onChangeModel: (m: string) => void
  onChangeThinkingOn: (v: boolean) => void
  onJump: Jump
  // 对话历史：当前打开的会话 id（null = 新对话）；标题由首条提问自动生成
  activeChatId: number | null
  onChatStarted: (id: number) => void
  onChatsChanged: () => void
  // 检索范围：勾选的文献（阅读模式侧栏加入）；非空时优先于 ScopePill 的分类范围
  picks: Paper[]
  onRemovePick: (id: number) => void
  onClearPicks: () => void
  // 回阅读模式重新勾选（勾选状态保留）
  onRepick: () => void
  // 对话字号（问答/翻译/对话共用）
  fs: number
  onFs: (delta: number) => void
}

// 全库对话主界面（Chat 模式）：hero 欢迎态 + 全屏 RAG 问答。
// 建议问题由库内内容实时生成（标题关键词/分类/近期文献），不再是固定三条
// 用户消息悬停操作（复制 / 编辑重生成）
function UserActions({ content, onEdit }: { content: string; onEdit: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <span className="msg-acts">
      <button
        title={copied ? '已复制' : '复制'}
        onClick={() => {
          void navigator.clipboard.writeText(content).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            },
            () => {}
          )
        }}
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        )}
      </button>
      <button title="编辑并重新生成回答" onClick={onEdit}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
      </button>
    </span>
  )
}

export default function ChatView({
  papers,
  paperCount,
  cats,
  catCounts,
  scope,
  onScopeChange,
  models,
  model,
  thinkingOn,
  onChangeModel,
  onChangeThinkingOn,
  onJump,
  activeChatId,
  onChatStarted,
  onChatsChanged,
  picks,
  onRemovePick,
  onClearPicks,
  onRepick,
  fs,
  onFs
}: Props): JSX.Element {
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // 流式累计器：onEnd 时落库完整回答
  const outRef = useRef('')
  const srcRef = useRef<SourceRef[] | undefined>(undefined)
  // 后校验报告：主流程生成完成后异步送达，到达时补进最后一条消息
  const verRef = useRef<VerifyReport | undefined>(undefined)
  // 本会话是刚在本组件里创建的：activeChatId 流回来时跳过重载（会把流式中的占位回答冲掉）
  const selfStartedRef = useRef<number | null>(null)
  // 本轮的基底消息（用户问题之前的上下文）：onEnd 全量落库与「编辑重生成」都要用
  const baseRef = useRef<ChatMsg[]>([])
  // 正在编辑的用户消息下标与草稿
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  // 当前流式请求的中断句柄（发送按钮生成中变「停止」）
  const stopRef = useRef<(() => void) | null>(null)
  const doStop = (): void => {
    stopRef.current?.()
    stopRef.current = null
    setBusy(false)
  }
  const scrollBottom = () => setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }), 50)

  const suggestions = useMemo(() => buildSuggestions(papers, catCounts), [papers, catCounts])

  // 来源面板（Google 风格）：最后一条回答的引用论文列表（主进程已按论文去重），
  // 显示 题目/期刊·年份/作者/被引数（CrossRef best-effort，refcache 缓存），点击跳阅读界面
  const [srcPanelOpen, setSrcPanelOpen] = useState(true)
  const [citedByMap, setCitedByMap] = useState<Record<string, number | null>>({})
  const citedFetched = useRef(new Set<string>())
  const lastSources = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') return msgs[i].sources ?? []
    }
    return []
  }, [msgs])
  useEffect(() => {
    if (!srcPanelOpen || !lastSources.length) return
    for (const s of lastSources) {
      if (citedFetched.current.has(s.slug)) continue
      citedFetched.current.add(s.slug)
      setCitedByMap((m) => ({ ...m, [s.slug]: null })) // 占位：请求中/未知
      void window.api
        .citedBy(s.slug, s.title)
        .then((n) => setCitedByMap((m) => ({ ...m, [s.slug]: n })))
        .catch(() => {})
    }
  }, [srcPanelOpen, lastSources])

  // 打开历史对话：载入消息停在底部；activeChatId 置 null（新建对话）只清空
  useEffect(() => {
    setEditIdx(null)
    if (activeChatId == null) {
      setMsgs([])
      return
    }
    if (selfStartedRef.current === activeChatId) {
      selfStartedRef.current = null
      return
    }
    let stale = false
    void window.api.chatLoad(activeChatId).then((ms) => {
      if (stale) return
      setMsgs(ms)
      if (ms.length) setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9 }), 30)
    })
    return () => {
      stale = true
    }
  }, [activeChatId])

  // 统一提问入口：base = 本轮问题之前的上下文。send 走 append（问题先落库），
  // 编辑重生成走 onEnd 的 setMessages 全量重写覆盖旧回答
  const ask = (q: string, base: ChatMsg[]): void => {
    if (busy || !q) return
    // 带最近两轮问答做多轮追问（取本轮之前的消息）
    const history = base.slice(-4).map((m) => ({ role: m.role, content: m.content }))
    setInput('')
    setEditIdx(null)
    setMsgs([...base, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setBusy(true)
    outRef.current = ''
    srcRef.current = undefined
    verRef.current = undefined
    baseRef.current = base
    scrollBottom()
    void (async () => {
      // 新对话：首次提问时落 chats 行，标题取问题前 24 字
      let cid = activeChatId
      if (cid == null) {
        const title = q.replace(/\s+/g, ' ').slice(0, 24) || '新对话'
        cid = await window.api.chatCreate(title)
        selfStartedRef.current = cid
        onChatStarted(cid)
        onChatsChanged()
      }
      const chatId = cid
      void window.api.chatAppend(chatId, 'user', q)
      stopRef.current = window.api.stream(
        {
          mode: 'rag',
          question: q,
          category: picks.length ? undefined : scope.type === 'cat' ? scope.cat : undefined,
          paperIds: picks.length ? picks.map((p) => p.id) : undefined,
          history
        },
        {
          onDelta: (d) => {
            outRef.current += d
            setMsgs((ms) => {
              const next = [...ms]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + d }
              return next
            })
          },
          onSources: (srcs) => {
            srcRef.current = srcs as SourceRef[]
            setSrcPanelOpen(true) // 新回答到达时自动展开来源面板
            setMsgs((ms) => {
              const next = [...ms]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, sources: srcs as SourceRef[] }
              return next
            })
          },
          onVerify: (v) => {
            verRef.current = v as VerifyReport
            setMsgs((ms) => {
              const next = [...ms]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, verify: v as VerifyReport }
              return next
            })
          },
          onEnd: () => {
            // 无条件全量重写落库（空回答行由 db 层过滤）：
            // 正常发送 = 去掉开头预写的 user 后重写一遍；编辑重生成 = 覆盖旧回答。
            // 条件化会在回答为空（LLM 返回空/中断）时留下旧问答与界面不一致
            const final: ChatMsg[] = [
              ...baseRef.current,
              { role: 'user', content: q },
              {
                role: 'assistant',
                content: outRef.current,
                ...(srcRef.current ? { sources: srcRef.current } : {}),
                ...(verRef.current ? { verify: verRef.current } : {})
              }
            ]
            void window.api.chatSetMessages(chatId, final)
            setBusy(false)
            onChatsChanged()
            scrollBottom()
          }
        }
      )
    })()
  }

  const send = (raw?: string): void => {
    const q = (raw ?? input).trim()
    if (!q || busy) return
    ask(q, msgs)
  }

  // 编辑某条用户问题并重生成：截掉该条及之后，重新提问（旧回答被覆盖）
  const submitEdit = (): void => {
    if (editIdx == null || busy) return
    const q = editText.trim()
    if (!q) return
    ask(q, msgs.slice(0, editIdx))
  }

  // 引用跳转带上「该轮的问题 + 芯片所在回答的局部上下文」：
  // snippet 未命中或缺失时用它做关键词定位，read 模式整篇问答也靠它精确定位段落
  const jumpFor = (i: number): Jump => {
    const q = msgs[i - 1]?.role === 'user' ? msgs[i - 1].content : ''
    return (slug, page, snippet, ctx) => onJump(slug, page, snippet, [q, ctx].filter(Boolean).join('\n'))
  }

  const fsCtl = (
    <div className="fs-ctl" title={`对话字号（当前 ${fs}px，问答/翻译/对话共用）`}>
      <button onClick={() => onFs(-1)} title="减小字号">
        A−
      </button>
      <button onClick={() => onFs(1)} title="增大字号">
        A+
      </button>
    </div>
  )

  // 检索范围展示：统一折叠成胶囊下拉列表（参考已打开文献选择器），点开管理：
  // 逐篇移除 / 重选（回阅读模式调整勾选，勾选保留）/ 清除全部。
  // 有勾选时原分类范围选择器让位
  const [pickMenuOpen, setPickMenuOpen] = useState(false)
  const pickMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pickMenuOpen) return
    const h = (e: MouseEvent): void => {
      if (!pickMenuRef.current?.contains(e.target as Node)) setPickMenuOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [pickMenuOpen])

  const pickTitle = (id: number, fallback: string): string => papers.find((x) => x.id === id)?.title ?? fallback

  const pickPill = picks.length > 0 && (
    <div className="pill-wrap" ref={pickMenuRef}>
      <button className={`ctl-pill ${pickMenuOpen ? 'on' : ''}`} onClick={() => setPickMenuOpen((o) => !o)} title="勾选的检索范围（点击管理）">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11.5a5 5 0 1 1 5 5c-1 0-1.8-.2-2.6-.6L7 17l1.1-3.2A5 5 0 0 1 9 11.5z" />
        </svg>
        <span className="ctl-label">检索范围 · {picks.length} 篇</span>
      </button>
      {pickMenuOpen && (
        <div className="pick-pill-menu">
          {picks.map((p) => (
            <div key={p.id} className="pick-pill-item" title={p.title}>
              <span className="ellipsis">{pickTitle(p.id, p.title)}</span>
              <i
                title="移除"
                onClick={() => {
                  onRemovePick(p.id)
                  if (picks.length <= 1) setPickMenuOpen(false)
                }}
              >
                ✕
              </i>
            </div>
          ))}
          <div className="pick-pill-foot">
            <button className="pick-clear" onClick={onRepick}>
              重选
            </button>
            <button className="pick-clear" onClick={onClearPicks}>
              清除全部
            </button>
          </div>
        </div>
      )}
    </div>
  )

  const inputBox = (
    <div className="hero-input">
      <textarea
        className="hero-textarea"
        placeholder={picks.length ? `在勾选的 ${picks.length} 篇文献中检索问答…` : '与全库文献对话，如：这个库里有哪些关于热建模的论文？'}
        value={input}
        rows={2}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div className="hero-input-foot">
        {picks.length === 0 && <ScopePill cats={cats} scope={scope} onChange={onScopeChange} paperCount={paperCount} catCounts={catCounts} />}
        {pickPill}
        <ModelPill models={models} model={model} onChange={onChangeModel} />
        <ThinkingToggle on={thinkingOn} onChange={onChangeThinkingOn} />
        {fsCtl}
        <span style={{ flex: 1 }} />
        <button
          className={`send-btn ${busy ? 'stop' : ''}`}
          onClick={() => (busy ? doStop() : send())}
          disabled={!busy && !input.trim()}
          title={busy ? '停止生成' : '发送（Enter）'}
        >
          {busy ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 3.5L2.5 10.2l7.3 2.9 2.9 7.3 8.8-16.9z" />
              <path d="M9.8 13.1l4.7-4.7" />
            </svg>
          )}
          {busy ? '停止' : '发送'}
        </button>
      </div>
    </div>
  )

  const srcPanel = lastSources.length > 0 ? (
    srcPanelOpen ? (
      <div className="src-panel">
        <div className="src-panel-head">
          <span>来源文献 · {lastSources.length}</span>
          <button className="src-panel-x" onClick={() => setSrcPanelOpen(false)}>
            收起
          </button>
        </div>
        <div className="src-panel-list">
          {lastSources.map((s) => (
            <button key={s.n} className="src-card" onClick={() => onJump(s.slug, 1)} title="点击跳转到阅读界面">
              <span className="src-card-venue ellipsis">{s.venue || '文献来源'}</span>
              <span className="src-card-title">{s.title}</span>
              <span className="src-card-meta ellipsis">
                {[
                  s.authors && s.authors.length > 42 ? `${s.authors.slice(0, 42)}…` : s.authors,
                  s.year,
                  citedByMap[s.slug] != null ? `被引 ${citedByMap[s.slug]}` : undefined
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          ))}
        </div>
      </div>
    ) : (
      <button className="src-panel-restore" onClick={() => setSrcPanelOpen(true)}>
        来源 · {lastSources.length} 篇
      </button>
    )
  ) : null

  return (
    <div className="chat-view">
      {msgs.length === 0 ? (
        <div className="chat-hero-wrap">
          <div className="chat-hero">
            <div className="big-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a8 8 0 0 1-8 8H4l2.2-2.6A8 8 0 1 1 21 12z" />
              </svg>
            </div>
            <div className="headline">与全库文献对话</div>
            <div className="tip">回答按论文编号引用，悬停看论文信息，点击直达原文首页</div>
          </div>
          {inputBox}
          <div className="hero-suggest">
            {suggestions.map((s) => (
              <button key={s} onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="chat-main-row">
            <div className="chat-log" ref={scrollRef}>
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === 'user' ? (
                  editIdx === i ? (
                    <div className="msg-edit">
                      <textarea
                        autoFocus
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            submitEdit()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setEditIdx(null)
                          }
                        }}
                      />
                      <div className="msg-edit-foot">
                        <span className="hint">重新提交将替换本条问题并重新生成下面的回答</span>
                        <span style={{ flex: 1 }} />
                        <button className="btn ghost" onClick={() => setEditIdx(null)}>
                          取消
                        </button>
                        <button className="btn" onClick={submitEdit} disabled={busy || !editText.trim()}>
                          重新生成
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="bubble">
                      {m.content}
                      <UserActions content={m.content} onEdit={() => { setEditIdx(i); setEditText(m.content) }} />
                    </div>
                  )
                ) : (
                  <div className="bubble">
                    {renderRich(m.content, m.sources, jumpFor(i))}
                    {m.verify && <VerifyBar v={m.verify} />}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="thinking">
                <span className="b" /> <span className="b" /> <span className="b" /> 检索并思考中…
              </div>
            )}
            </div>
            {srcPanel}
          </div>
          <div className="chat-view-input">{inputBox}</div>
        </>
      )}
    </div>
  )
}
