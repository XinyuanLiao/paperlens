import { useEffect, useRef, useState } from 'react'

const THINK_LABEL: Record<string, string> = { default: '默认', off: '关闭', low: '低', medium: '中', high: '高' }
const THINK_ORDER = ['default', 'off', 'low', 'medium', 'high']

function useClickOutside(open: boolean, close: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open, close])
  return ref
}

const Caret = (): JSX.Element => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
)

const ChipCheck = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
)

// Ollama 风格：底部输入区的模型 / 思考等级 胶囊选择器
export function ModelPill({ models, model, onChange }: { models: string[]; model: string; onChange: (m: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const close = (): void => setOpen(false)
  const ref = useClickOutside(open, close)
  return (
    <div className="pill-wrap" ref={ref}>
      <button className="ctl-pill" title="切换模型（在设置中可填多个，逗号分隔）" onClick={() => setOpen((v) => !v)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <circle cx="9.2" cy="10.4" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="14.8" cy="10.4" r="0.9" fill="currentColor" stroke="none" />
          <path d="M8.5 14.5c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5" />
        </svg>
        <span className="ellipsis ctl-label">{model || '选择模型'}</span>
        <Caret />
      </button>
      {open && (
        <div className="pill-menu up">
          {models.length === 0 && <div className="pill-note">尚未填写模型：设置 → 模型（可填多个）</div>}
          {models.map((m) => (
            <button
              key={m}
              className={`pill-item ${m === model ? 'on' : ''}`}
              onClick={() => {
                onChange(m)
                close()
              }}
            >
              <span className="ellipsis">{m}</span>
              {m === model && <ChipCheck />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ThinkingPill({ level, onChange }: { level: string; onChange: (l: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const close = (): void => setOpen(false)
  const ref = useClickOutside(open, close)
  const cur = THINK_LABEL[level] ?? '默认'
  return (
    <div className="pill-wrap" ref={ref}>
      <button className="ctl-pill" title="思考等级（按服务商映射；不支持的服务商由模型决定）" onClick={() => setOpen((v) => !v)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v2M5.6 5.6l1.4 1.4M3 12h2M5.6 18.4l1.4-1.4M12 21v-2M18.4 18.4L17 17M21 12h-2M18.4 5.6L17 7" />
          <circle cx="12" cy="12" r="3.4" />
        </svg>
        <span className="ctl-label">思考·{cur}</span>
        <Caret />
      </button>
      {open && (
        <div className="pill-menu up">
          {THINK_ORDER.map((l) => (
            <button
              key={l}
              className={`pill-item ${l === level ? 'on' : ''}`}
              onClick={() => {
                onChange(l)
                close()
              }}
            >
              <span>思考·{THINK_LABEL[l]}</span>
              {l === level && <ChipCheck />}
            </button>
          ))}
          <div className="pill-note">zhipu/qwen/openai 支持分级；其余由模型决定</div>
        </div>
      )}
    </div>
  )
}
