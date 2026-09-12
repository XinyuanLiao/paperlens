import { useEffect, useRef, useState } from 'react'

const THINK_LABEL: Record<string, string> = { default: '默认', off: '关闭', low: '低', medium: '中', high: '高' }
const THINK_ORDER = ['default', 'off', 'low', 'medium', 'high']

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

// Ollama 风格：底部输入区的模型 / 思考 / 检索范围 胶囊选择器
function Pill({
  icon,
  label,
  title,
  open,
  setOpen,
  compact,
  children
}: {
  icon: JSX.Element
  label: string
  title?: string
  open: boolean
  setOpen: (v: boolean) => void
  compact?: boolean
  children: React.ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open, setOpen])
  return (
    <div className="pill-wrap" ref={ref}>
      <button className={`ctl-pill ${open ? 'on' : ''}`} title={title} onClick={() => setOpen(!open)}>
        {icon}
        {!compact && <span className="ctl-label">{label}</span>}
        <Caret />
      </button>
      {open && <div className="pill-menu up">{children}</div>}
    </div>
  )
}

export function ModelPill({
  models,
  model,
  onChange,
  compact
}: {
  models: string[]
  model: string
  onChange: (m: string) => void
  compact?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Pill
      compact={compact}
      open={open}
      setOpen={setOpen}
      label={model || '选择模型'}
      title="切换模型（在设置中可填多个，逗号分隔）"
      icon={
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <circle cx="9.2" cy="10.4" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="14.8" cy="10.4" r="0.9" fill="currentColor" stroke="none" />
          <path d="M8.5 14.5c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5" />
        </svg>
      }
    >
      {models.length === 0 && <div className="pill-note">尚未填写模型：设置 → 模型与服务商</div>}
      {models.map((m) => (
        <button
          key={m}
          className={`pill-item ${m === model ? 'on' : ''}`}
          onClick={() => {
            onChange(m)
            setOpen(false)
          }}
        >
          <span className="ellipsis">{m}</span>
          {m === model && <ChipCheck />}
        </button>
      ))}
    </Pill>
  )
}

export function ThinkingPill({
  level,
  onChange,
  compact
}: {
  level: string
  onChange: (l: string) => void
  compact?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const cur = THINK_LABEL[level] ?? '默认'
  return (
    <Pill
      compact={compact}
      open={open}
      setOpen={setOpen}
      label={`思考·${cur}`}
      title="思考等级（按服务商映射；不支持的服务商由模型决定）"
      icon={
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v2M5.6 5.6l1.4 1.4M3 12h2M5.6 18.4l1.4-1.4M12 21v-2M18.4 18.4L17 17M21 12h-2M18.4 5.6L17 7" />
          <circle cx="12" cy="12" r="3.4" />
        </svg>
      }
    >
      {THINK_ORDER.map((l) => (
        <button
          key={l}
          className={`pill-item ${l === level ? 'on' : ''}`}
          onClick={() => {
            onChange(l)
            setOpen(false)
          }}
        >
          <span>思考·{THINK_LABEL[l]}</span>
          {l === level && <ChipCheck />}
        </button>
      ))}
    </Pill>
  )
}

export interface ChatScope {
  type: 'all' | 'cat'
  cat: string
}

export function ScopePill({
  cats,
  scope,
  onChange,
  paperCount,
  catCounts
}: {
  cats: string[]
  scope: ChatScope
  onChange: (s: ChatScope) => void
  paperCount: number
  catCounts: Map<string, number>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const label = scope.type === 'all' ? `全库 · ${paperCount} 篇` : `${scope.cat} · ${catCounts.get(scope.cat) ?? 0} 篇`
  return (
    <Pill
      open={open}
      setOpen={setOpen}
      label={label}
      title="选择检索范围"
      icon={
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      }
    >
      <button
        className={`pill-item ${scope.type === 'all' ? 'on' : ''}`}
        onClick={() => {
          onChange({ type: 'all', cat: '' })
          setOpen(false)
        }}
      >
        <span>全库（{paperCount} 篇）</span>
        {scope.type === 'all' && <ChipCheck />}
      </button>
      {cats.map((c) => (
        <button
          key={c}
          className={`pill-item ${scope.type === 'cat' && scope.cat === c ? 'on' : ''}`}
          onClick={() => {
            onChange({ type: 'cat', cat: c })
            setOpen(false)
          }}
        >
          <span className="ellipsis">{c}</span>
          {scope.type === 'cat' && scope.cat === c && <ChipCheck />}
        </button>
      ))}
    </Pill>
  )
}
