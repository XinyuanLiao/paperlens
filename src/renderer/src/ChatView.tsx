import { useEffect, useMemo, useRef, useState } from 'react'
import { renderRich, type Jump } from './rich'
import { buildSuggestions } from './suggest'
import { ModelPill, ThinkingPill, ScopePill, type ChatScope } from './ChatControls'
import type { ChatMsg, Paper, SourceRef } from './types'

interface Props {
  papers: Paper[]
  paperCount: number
  cats: string[]
  catCounts: Map<string, number>
  scope: ChatScope
  onScopeChange: (s: ChatScope) => void
  models: string[]
  model: string
  thinking: string
  onChangeModel: (m: string) => void
  onChangeThinking: (l: string) => void
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
export default function ChatView({
  papers,
  paperCount,
  cats,
  catCounts,
  scope,
  onScopeChange,
  models,
  model,
  thinking,
  onChangeModel,
  onChangeThinking,
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
  // 本会话是刚在本组件里创建的：activeChatId 流回来时跳过重载（会把流式中的占位回答冲掉）
  const selfStartedRef = useRef<number | null>(null)
  const scrollBottom = () => setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }), 50)

  const suggestions = useMemo(() => buildSuggestions(papers, catCounts), [papers, catCounts])

  // 打开历史对话：载入消息停在底部；activeChatId 置 null（新建对话）只清空
  useEffect(() => {
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

  const send = (raw?: string): void => {
    const q = (raw ?? input).trim()
    if (!q || busy) return
    // 带最近两轮问答做多轮追问（在追加本轮消息之前取历史）
    const history = msgs.slice(-4).map((m) => ({ role: m.role, content: m.content }))
    setInput('')
    setMsgs((ms) => [...ms, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setBusy(true)
    outRef.current = ''
    srcRef.current = undefined
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
      window.api.stream(
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
            setMsgs((ms) => {
              const next = [...ms]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, sources: srcs as SourceRef[] }
              return next
            })
          },
          onEnd: () => {
            if (outRef.current.trim()) {
              void window.api.chatAppend(chatId, 'assistant', outRef.current, srcRef.current ? JSON.stringify(srcRef.current) : undefined)
            }
            setBusy(false)
            onChatsChanged()
            scrollBottom()
          }
        }
      )
    })()
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

  // 检索范围展示：≤3 篇用输入框上方 chips；更多折叠成胶囊下拉（参考已打开文献列表）。
  // 无论多少篇，原分类范围选择器都让位给「重选」入口——随时回阅读模式调整勾选
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

  const pickChips = picks.length > 0 && picks.length <= 3 && (
    <div className="pick-chips">
      <span className="pick-chips-label">检索范围 · {picks.length} 篇</span>
      {picks.map((p) => (
        <span key={p.id} className="pick-chip" title={p.title}>
          <span className="pc-t">{pickTitle(p.id, p.title)}</span>
          <i title="移除" onClick={() => onRemovePick(p.id)}>
            ✕
          </i>
        </span>
      ))}
      <button className="pick-clear" onClick={onRepick} title="回到阅读模式调整勾选">
        重选
      </button>
      <button className="pick-clear" onClick={onClearPicks}>
        清除
      </button>
    </div>
  )

  const pickPill = picks.length > 3 && (
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
      {pickChips}
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
        {picks.length > 0 && picks.length <= 3 && (
          <button className="ctl-pill" title="回到阅读模式调整勾选" onClick={onRepick}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11.5a5 5 0 1 1 5 5c-1 0-1.8-.2-2.6-.6L7 17l1.1-3.2A5 5 0 0 1 9 11.5z" />
            </svg>
            <span className="ctl-label">已选 {picks.length} 篇 · 重选</span>
          </button>
        )}
        {pickPill}
        <ModelPill models={models} model={model} onChange={onChangeModel} />
        <ThinkingPill level={thinking} onChange={onChangeThinking} />
        {fsCtl}
        <span style={{ flex: 1 }} />
        <button className="send-btn" onClick={() => send()} disabled={busy || !input.trim()}>
          发送
        </button>
      </div>
    </div>
  )

  return (
    <div className="chat-view">
      {msgs.length === 0 ? (
        <div className="chat-hero-wrap">
          <div className="chat-hero">
            <div className="big">💬</div>
            <div className="headline">与全库文献对话</div>
            <div className="tip">跨所有论文语义检索，回答自带页码引用，点击引用直达原文</div>
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
          <div className="chat-log" ref={scrollRef}>
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="bubble">{renderRich(m.content, m.sources, jumpFor(i))}</div>
              </div>
            ))}
            {busy && (
              <div className="thinking">
                <span className="b" /> <span className="b" /> <span className="b" /> 检索并思考中…
              </div>
            )}
          </div>
          <div className="chat-view-input">{inputBox}</div>
        </>
      )}
    </div>
  )
}
