import { useEffect, useMemo, useRef, useState } from 'react'
import type { Paper } from './types'
import { catLabel } from './LibraryPane'

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run: () => void
}

interface Props {
  papers: Paper[]
  commands: PaletteCommand[]
  onClose: () => void
  onOpenPaper: (p: Paper) => void
}

type Row =
  | { kind: 'command'; cmd: PaletteCommand }
  | { kind: 'paper'; paper: Paper }

export default function CommandPalette({ papers, commands, onClose, onOpenPaper }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const kw = q.trim().toLowerCase()

  const rows = useMemo<Row[]>(() => {
    const hit = (s: string): boolean => !kw || s.toLowerCase().includes(kw)
    const cmds: Row[] = commands.filter((c) => hit(c.label)).map((cmd) => ({ kind: 'command', cmd }))
    const pprs: Row[] = papers
      .filter((p) => hit(p.title) || hit(p.slug) || hit(p.category) || String(p.year ?? '').includes(kw))
      .slice(0, 30)
      .map((paper) => ({ kind: 'paper', paper }))
    return [...cmds, ...pprs]
  }, [kw, commands, papers])

  useEffect(() => {
    setSel(0)
  }, [kw])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const runRow = (r: Row): void => {
    onClose()
    if (r.kind === 'command') r.cmd.run()
    else onOpenPaper(r.paper)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(rows.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = rows[sel]
      if (r) runRow(r)
    }
  }

  const groups: Array<{ label: string; items: Array<{ row: Row; i: number }> }> = []
  rows.forEach((row, i) => {
    const label = row.kind === 'command' ? '命令' : '文献'
    const g = groups[groups.length - 1]
    if (g && g.label === label) g.items.push({ row, i })
    else groups.push({ label, items: [{ row, i }] })
  })

  return (
    <div className="palette-mask" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="搜索文献，或输入命令…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && <div className="palette-empty">没有匹配的结果</div>}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="palette-group">{g.label}</div>
              {g.items.map(({ row, i }) => (
                <div
                  key={row.kind === 'command' ? row.cmd.id : `p${row.paper.id}`}
                  className={`palette-item ${i === sel ? 'sel' : ''}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => runRow(row)}
                >
                  {row.kind === 'command' ? (
                    <>
                      <span className="pi-label">{row.cmd.label}</span>
                      {row.cmd.hint && <span className="pi-meta">{row.cmd.hint}</span>}
                    </>
                  ) : (
                    <>
                      <span className="pi-label">{row.paper.title}</span>
                      <span className="pi-meta">
                        {row.paper.year ?? '—'} · {catLabel(row.paper.category)}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
