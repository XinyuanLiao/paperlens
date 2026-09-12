import { useRef, useState } from 'react'
import { renderRich } from './rich'
import type { ChatMsg } from './types'

interface Props {
  paperCount: number
  onJump: (slug: string, page: number) => void
}

const SUGGESTIONS = [
  '这个文献库里有哪些研究方向？',
  '帮我梳理库中与热建模相关的论文',
  '对比库里 TSFM 方法的异同'
]

// 全库对话主界面（Chat 模式）：hero 欢迎态 + 全屏 RAG 问答
export default function ChatView({ paperCount, onJump }: Props): JSX.Element {
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollBottom = () => setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }), 50)

  const send = (raw?: string): void => {
    const q = (raw ?? input).trim()
    if (!q || busy) return
    setInput('')
    setMsgs((ms) => [...ms, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setBusy(true)
    scrollBottom()
    window.api.stream(
      { mode: 'rag', question: q },
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
  }

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
        <span className="hero-scope">全库检索 · {paperCount} 篇</span>
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
            {SUGGESTIONS.map((s) => (
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
                <div className="who">{m.role === 'user' ? '你' : 'AI'}</div>
                <div className="bubble">{renderRich(m.content, m.sources, onJump)}</div>
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
