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
        { mode: 'rag', question: q, category: scope.type === 'cat' ? scope.cat : undefined, history },
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

  const inputBox = (
    <div className="hero-input">
      <textarea
        className="hero-textarea"
        placeholder="与全库文献对话，如：这个库里有哪些关于热建模的论文？"
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
        <ScopePill cats={cats} scope={scope} onChange={onScopeChange} paperCount={paperCount} catCounts={catCounts} />
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
