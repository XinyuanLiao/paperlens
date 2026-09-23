import { useEffect, useRef } from 'react'

export interface CtxItem {
  label: string
  danger?: boolean
  disabled?: boolean
  action?: () => void
  sep?: boolean
}

// 自绘右键菜单：替代原生 Menu（原生菜单项上下边距过大且无法随主题定制）
export default function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxItem[]; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  const W = 200
  const nItems = items.filter((i) => !i.sep).length
  const H = nItems * 32 + (items.length - nItems) * 11 + 10
  const left = Math.max(6, Math.min(x, window.innerWidth - W - 8))
  const top = Math.max(6, Math.min(y, window.innerHeight - H - 8))
  return (
    <div className="ctx-menu" ref={ref} style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.action?.()
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  )
}
