import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { renderRich, type Jump } from './rich'
import { ModelPill, ThinkingPill } from './ChatControls'
import type { ChatMsg, Paper, SourceRef } from './types'

export interface SideControl {
  translate: (text: string, context: string) => void
  explain: (text: string, context: string) => void
  quote: (text: string) => void
  reset: () => void
}

interface Props {
  paper: Paper | null
  pageContext: string
  onJump: Jump
  models: string[]
  model: string
  thinking: string
  onChangeModel: (m: string) => void
  onChangeThinking: (l: string) => void
  width: number
  // 对话字号（问答/翻译/对话共用）
  fs: number
  onFs: (delta: number) => void
}

interface Translation {
  src: string
  out: string
}

const SidePanel = forwardRef<SideControl, Props>(function SidePanel(
  { paper, pageContext, onJump, models, model, thinking, onChangeModel, onChangeThinking, width, fs, onFs },
  ref
): JSX.Element {
  const [tab, setTab] = useState<'chat' | 'translate'>('chat')
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState<'paper' | 'lib'>('paper')
  const [current, setCurrent] = useState<Translation | null>(null)
  const [ctxOn, setCtxOn] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef('')
  const curRef = useRef<Translation | null>(null)

  const scrollBottom = () => setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }), 50)

  useImperativeHandle(ref, () => ({
    translate(text: string, context: string) {
      ctxRef.current = context || pageContext
      setTab('translate')
      const item: Translation = { src: text, out: '' }
      setCurrent(item) // 只保留当前一条，新的选择直接覆盖
      curRef.current = item
      setCtxOn(true) // 自动加入问答上下文
      setBusy(true)
      window.api.stream(
        { mode: 'translate', text, context: ctxRef.current.slice(0, 1800) },
        {
          onDelta: (d) => {
            if (curRef.current === item) {
              item.out += d
              setCurrent({ ...item })
            }
          },
          onEnd: () => setBusy(false)
        }
      )
    },
    explain(text: string, context: string) {
      ctxRef.current = context || pageContext
      setTab('chat')
      setMsgs((ms) => [...ms, { role: 'user', content: `解释一下这段话：\n「${text.slice(0, 500)}」` }])
      setBusy(true)
      scrollBottom()
      window.api.stream(
        { mode: 'explain', text, context: ctxRef.current.slice(0, 1800) },
        {
          onDelta: (d) =>
            setMsgs((ms) => {
              const next = [...ms]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + d }
              else next.push({ role: 'assistant', content: d })
              return next
            }),
          onEnd: () => setBusy(false)
        }
      )
      scrollBottom()
    },
    quote(text: string) {
      setTab('chat')
      setInput((v) => (v ? v + '\n' : '') + `关于这段内容：「${text.slice(0, 300)}」\n`)
    },
    reset
  }))

  const ctxTranslation = ctxOn && current?.out ? current : null

  // 引用跳转带上「该轮的问题 + 芯片所在回答的局部上下文」：
  // 整篇问答模式没有 snippet，靠它们做关键词定位到页内段落
  const jumpFor = (i: number): Jump => {
    const q = msgs[i - 1]?.role === 'user' ? msgs[i - 1].content : ''
    return (slug, page, snippet, ctx) => onJump(slug, page, snippet, [q, ctx].filter(Boolean).join('\n'))
  }

  // 新对话：清空问答记录、翻译卡片与问答上下文（论文问答不持久化，仅当前会话内保留）
  const reset = (): void => {
    setMsgs([])
    setCurrent(null)
    setCtxOn(false)
    ctxRef.current = ''
    curRef.current = null
  }

  const send = () => {
    const q = input.trim()
    if (!q || busy) return
    // 带最近两轮问答做多轮追问（在追加本轮消息之前取历史）
    const history = msgs.slice(-4).map((m) => ({ role: m.role, content: m.content }))
    setInput('')
    setTab('chat')
    setMsgs((ms) => [...ms, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setBusy(true)
    scrollBottom()
    const ctxNote = ctxTranslation ? `\n\n（参考：我刚翻译了「${ctxTranslation.src.slice(0, 120)}」→「${ctxTranslation.out.slice(0, 300)}」）` : ''
    window.api.stream(
      { mode: 'rag', question: q + ctxNote, scopePaperId: scope === 'paper' && paper ? paper.id : undefined, paperTitle: paper?.title, history },
      {
        onDelta: (d) =>
          setMsgs((ms) => {
            const next = [...ms]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + d }
            return next
          }),
        onSources: (srcs) =>
          setMsgs((ms) => {
            const next = [...ms]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') next[next.length - 1] = { ...last, sources: srcs as SourceRef[] }
            return next
          }),
        onEnd: () => {
          setBusy(false)
          scrollBottom()
        }
      }
    )
    scrollBottom()
  }

  return (
    <div className="side" style={{ width }}>
      <div className="side-tabs">
        <div className={`side-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          问答
        </div>
        <div className={`side-tab ${tab === 'translate' ? 'active' : ''}`} onClick={() => setTab('translate')}>
          翻译
        </div>
        <button className="side-new-chat" title="新对话：清空问答记录与上下文" onClick={reset}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21c-4.4 0-8-3.1-8-7 0-2.2 1.2-4.2 3-5.5V4l3.2 1.8c.6-.1 1.2-.2 1.8-.2 4.4 0 8 3.1 8 7s-3.6 7-8 7z" />
            <path d="M12 7.5v5M9.5 10h5" />
          </svg>
          新对话
        </button>
        <div className="fs-ctl" title={`字号（当前 ${fs}px，问答/翻译/对话共用）`}>
          <button onClick={() => onFs(-1)} title="减小字号">
            A−
          </button>
          <button onClick={() => onFs(1)} title="增大字号">
            A+
          </button>
        </div>
      </div>
      {tab === 'chat' ? (
        <>
          <div className="chat-scroll" ref={scrollRef}>
            {msgs.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.9, padding: '6px 4px' }}>
                {paper ? (
                  <>
                    当前论文：<b style={{ color: 'var(--accent2)' }}>{paper.title}</b>
                    <br />
                    「当前论文」只在本文全文中检索；「全库」跨所有文献检索并给出来源页码。
                    <br />
                    在 PDF 里划词会自动翻译并加入这里的上下文。
                  </>
                ) : (
                  '全库模式：无需打开论文，直接跨所有文献检索问答，回答自带页码引用，点击可跳转。'
                )}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="bubble">{m.role === 'assistant' ? renderRich(m.content, m.sources, jumpFor(i)) : m.content}</div>
              </div>
            ))}
            {busy && (
              <div className="thinking">
                <span className="b" /> <span className="b" /> <span className="b" /> 思考中…
              </div>
            )}
          </div>
          <div className="chat-input-area">
            {ctxTranslation && (
              <div className="ctx-pill" title={`${ctxTranslation.src}\n→\n${ctxTranslation.out}`}>
                <span className="ctx-label">上下文</span>
                <span className="ellipsis" style={{ flex: 1 }}>
                  {ctxTranslation.src}
                </span>
                <span className="ctx-x" title="从问答上下文中移除（译文卡片保留）" onClick={() => setCtxOn(false)}>
                  ✕
                </span>
              </div>
            )}
            <div className="rag-toggle">
              检索范围
              {paper ? (
                <div className="seg">
                  <span className={scope === 'paper' ? 'on' : ''} onClick={() => setScope('paper')}>
                    当前论文
                  </span>
                  <span className={scope === 'lib' ? 'on' : ''} onClick={() => setScope('lib')}>
                    全库
                  </span>
                </div>
              ) : (
                <span className="lib-only-chip">全库检索</span>
              )}
            </div>
            <div className="side-controls">
              <ModelPill models={models} model={model} onChange={onChangeModel} />
              <ThinkingPill level={thinking} onChange={onChangeThinking} />
              <span style={{ flex: 1 }} />
              <span className="index-badge ellipsis" style={{ maxWidth: 110 }}>
                {paper ? paper.slug : '未打开论文'}
              </span>
            </div>
            <div className="input-row">              <textarea
                className="chat-input"
                placeholder={paper ? '问点什么…（Enter 发送，Shift+Enter 换行）' : '与全库文献对话…（Enter 发送，Shift+Enter 换行）'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <button className="send-btn" onClick={send} disabled={busy || !input.trim()}>
                发送
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="chat-scroll">
          {!current && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.9, padding: '6px 4px' }}>
              在 PDF 里划词 → 点「翻译」。只显示当前一条原文与译文；新的划词会覆盖，问答历史不受影响。
            </div>
          )}
          {current && (
            <div className="tr-card">
              <div className="tr-head">
                <span className="label">原文</span>
                {current.out && (
                  <button
                    className={`ctx-toggle ${ctxOn ? 'on' : ''}`}
                    title={ctxOn ? '从问答上下文移除' : '加入问答上下文'}
                    onClick={() => setCtxOn(!ctxOn)}
                  >
                    {ctxOn ? '已加入上下文 ✕' : '加入上下文'}
                  </button>
                )}
              </div>
              <div className="src-text">
                {current.src.slice(0, 400)}
                {current.src.length > 400 ? '…' : ''}
              </div>
              <div className="dst-text">{current.out || '翻译中…'}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export default SidePanel
