import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { renderRich, renderMathText, type Jump } from './rich'
import { ModelPill, ThinkingToggle } from './ChatControls'
import type { ChatMsg, Paper, SourceRef } from './types'

// 翻译译文渲染不需要引用跳转
const noopJump: Jump = () => {}

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
  thinkingOn: boolean
  onChangeModel: (m: string) => void
  onChangeThinkingOn: (v: boolean) => void
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
  { paper, pageContext, onJump, models, model, thinkingOn, onChangeModel, onChangeThinkingOn, width, fs, onFs },
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
  // 当前流式请求的中断句柄（发送按钮生成中变「停止」）
  const stopRef = useRef<(() => void) | null>(null)

  const doStop = (): void => {
    stopRef.current?.()
    stopRef.current = null
    setBusy(false)
  }

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
      stopRef.current = window.api.stream(
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
      setMsgs((ms) => [...ms, { role: 'user', content: `解释一下这段话：\n「${text}」` }])
      setBusy(true)
      scrollBottom()
      stopRef.current = window.api.stream(
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
      // 追问预填保留原文（上限 2000 字防输入框被超长选区撑爆），可手动编辑
      const q = text.length > 2000 ? `${text.slice(0, 2000)}……` : text
      setInput((v) => (v ? v + '\n' : '') + `关于这段内容：「${q}」\n`)
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
    stopRef.current = window.api.stream(
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
        <div className="side-tabs-actions">
          <button className="side-new" title="新对话：清空问答记录与上下文" onClick={reset}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.8-.3-4-.9L3 21l1.9-5.5A8.5 8.5 0 1 1 21 11.5z" />
              <path d="M12 8v7M8.5 11.5h7" />
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
                <div className="bubble">{m.role === 'assistant' ? renderRich(m.content, m.sources, jumpFor(i)) : renderMathText(m.content)}</div>
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
            {/* 输入盒与对话模式同款（hero-input）：文本区独占一行，控件与发送按钮同一行脚 */}
            <div className="hero-input">
              <textarea
                className="hero-textarea"
                rows={2}
                title="Enter 发送，Shift+Enter 换行"
                placeholder={paper ? '问点什么…（Enter 发送）' : '与全库文献对话…（Enter 发送）'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <div className="hero-input-foot">
                <ModelPill models={models} model={model} onChange={onChangeModel} />
                <ThinkingToggle on={thinkingOn} onChange={onChangeThinkingOn} />
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
              <div className="src-text">{renderMathText(current.src)}</div>
              <div className="dst-text">{renderRich(current.out || '翻译中…', undefined, noopJump)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export default SidePanel
