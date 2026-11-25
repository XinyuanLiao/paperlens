import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HL_COLORS, HL_COLOR_NAME } from './annotations'
import type { Highlight, HlColor, Note } from './types'

// 批注卡：点击页面上的高亮弹出——换颜色、写批注、就原文解释/翻译、删除。
// 页面笔记浮层：点击页面角落的笔记标记弹出，就地编辑。
// 两者都是 fixed 定点浮层：默认挂在锚点下方，下方放不下翻到上方，左右不出窗口

export interface Anchor {
  left: number
  top: number
  bottom: number
}

// 先隐身渲染量出高度，再定点（避免「先出现在错的位置再跳一下」）
function useAnchored(anchor: Anchor, width: number): { ref: React.RefObject<HTMLDivElement>; pos: { left: number; top: number } | null } {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const left = Math.max(8, Math.min(anchor.left - 14, window.innerWidth - width - 8))
    let top = anchor.bottom + 8
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, anchor.top - el.offsetHeight - 8)
    setPos({ left, top })
  }, [anchor.left, anchor.top, anchor.bottom, width])
  return { ref, pos }
}

// 点浮层外 / Esc 关闭。Esc 截获在捕获阶段并阻止传播：不让阅读器的其它快捷键同时触发
function useDismiss(ref: React.RefObject<Element>, onClose: () => void): void {
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [ref, onClose])
}

// 随内容长高的输入框（上限 8 行左右），⌘/Ctrl+Enter 收起
function NoteTextarea({
  value,
  onChange,
  placeholder,
  autoFocus,
  onDone
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  autoFocus?: boolean
  onDone: () => void
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      className="pop-textarea"
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onDone()
        }
        // 输入框里的 Esc 交给 useDismiss（捕获阶段），其余按键不冒泡到阅读器
        e.stopPropagation()
      }}
    />
  )
}

// 输入防抖落库；卸载（关闭浮层）时把没来得及保存的内容补写出去，一个字都不丢
function useAutosave(value: string, initial: string, save: (v: string) => void): void {
  const latest = useRef(value)
  latest.current = value
  const saved = useRef(initial)
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (value === saved.current) return
    const t = setTimeout(() => {
      saved.current = value
      saveRef.current(value)
    }, 450)
    return () => clearTimeout(t)
  }, [value])
  useEffect(
    () => () => {
      const last = latest.current
      if (last !== saved.current) saveRef.current(last)
    },
    []
  )
}

const POP_W = 304

export function AnnotationPopup({
  annotation,
  anchor,
  onChange,
  onDelete,
  onExplain,
  onTranslate,
  onClose
}: {
  annotation: Highlight
  anchor: Anchor
  onChange: (patch: { note?: string; color?: HlColor }) => void
  onDelete: () => void
  onExplain: (text: string) => void
  onTranslate: (text: string) => void
  onClose: () => void
}): JSX.Element {
  const [note, setNote] = useState(annotation.note)
  const [confirmDel, setConfirmDel] = useState(false)
  const [copied, setCopied] = useState(false)
  const { ref, pos } = useAnchored(anchor, POP_W)
  useDismiss(ref, onClose)
  useAutosave(note, annotation.note, (v) => onChange({ note: v }))

  // 删除两步确认：带批注的高亮误点一下就没了太危险
  useEffect(() => {
    if (!confirmDel) return
    const t = setTimeout(() => setConfirmDel(false), 2600)
    return () => clearTimeout(t)
  }, [confirmDel])

  const act = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <div className="pop ann-pop" ref={ref} onMouseDown={(e) => e.stopPropagation()} style={pos ? { left: pos.left, top: pos.top, width: POP_W } : undefined}>
      <div className="ann-pop-bar">
        <span className="ann-swatches">
          {HL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`ann-swatch ${annotation.color === c ? 'on' : ''}`}
              data-color={c}
              title={`${HL_COLOR_NAME[c]}${annotation.color === c ? '（当前）' : ''}`}
              onClick={() => onChange({ color: c })}
            />
          ))}
        </span>
        <span className="ann-pop-page">第 {annotation.page} 页</span>
        <button type="button" className="pop-x" title="收起（Esc）" onClick={onClose}>
          ✕
        </button>
      </div>
      {annotation.text.trim() && <div className="ann-pop-quote">{annotation.text}</div>}
      <NoteTextarea value={note} onChange={setNote} placeholder="写下想法、疑问或联想…（自动保存）" autoFocus={!annotation.note} onDone={onClose} />
      <div className="pop-foot">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(annotation.text).catch(() => {})
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? '已复制' : '复制原文'}
        </button>
        {annotation.text.trim() && (
          <>
            <button type="button" onClick={act(() => onExplain(annotation.text))}>
              解释
            </button>
            <button type="button" onClick={act(() => onTranslate(annotation.text))}>
              翻译
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={`pop-del ${confirmDel ? 'confirm' : ''}`}
          title={confirmDel ? '再点一次确认删除（含批注）' : '删除这条高亮'}
          onClick={() => {
            if (confirmDel) {
              onClose()
              onDelete()
            } else setConfirmDel(true)
          }}
        >
          {confirmDel ? '确认删除' : '删除'}
        </button>
      </div>
    </div>
  )
}

export function PageNotePopover({
  note,
  anchor,
  onSave,
  onDelete,
  onClose
}: {
  note: Note
  anchor: Anchor
  onSave: (content: string) => void
  onDelete: () => void
  onClose: () => void
}): JSX.Element {
  const [value, setValue] = useState(note.content)
  const [confirmDel, setConfirmDel] = useState(false)
  const { ref, pos } = useAnchored(anchor, POP_W)
  useDismiss(ref, onClose)
  useAutosave(value, note.content, onSave)
  useEffect(() => {
    if (!confirmDel) return
    const t = setTimeout(() => setConfirmDel(false), 2600)
    return () => clearTimeout(t)
  }, [confirmDel])
  return (
    <div className="pop ann-pop" ref={ref} onMouseDown={(e) => e.stopPropagation()} style={pos ? { left: pos.left, top: pos.top, width: POP_W } : undefined}>
      <div className="ann-pop-bar">
        <span className="ann-pop-page">第 {note.page} 页笔记</span>
        <button type="button" className="pop-x" title="收起（Esc）" onClick={onClose}>
          ✕
        </button>
      </div>
      <NoteTextarea value={value} onChange={setValue} placeholder="这一页的要点、疑问…" onDone={onClose} />
      <div className="pop-foot">
        <span className="pop-hint">清空即删除 · 自动保存</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={`pop-del ${confirmDel ? 'confirm' : ''}`}
          onClick={() => {
            if (confirmDel) {
              onClose()
              onDelete()
            } else setConfirmDel(true)
          }}
        >
          {confirmDel ? '确认删除' : '删除'}
        </button>
      </div>
    </div>
  )
}
