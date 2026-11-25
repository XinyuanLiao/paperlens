import { useEffect, useRef, useState } from 'react'
import { renderRich, type Jump } from './rich'
import { useReasoning, ReasonStrip } from './reason'
import { updateAnnotation, removeAnnotation, upsertNote, removeNote, HL_COLOR_NAME } from './annotations'
import type { Highlight, Note, Paper } from './types'

// 侧栏「笔记」页：一篇论文的全部批注与笔记在这里集中查看、编辑、导出。
//   - 全文笔记：整篇一条，自动保存
//   - 页面笔记：不绑定选区的自由文字，可就当前页新建
//   - 批注清单：按页排列，点原文跳回页面，批注文字就地编辑
//   - AI 整理：把批注与笔记交给模型归纳成一份结构化阅读笔记（可追加到全文笔记）
// 由 SidePanel 以 key={paper.id} 挂载：换论文即重建，草稿与展开状态不会串到别的论文上

const noopJump: Jump = () => {}

// 「删除」两步确认：带内容的条目误点一下就没了太危险
function useConfirm(): [boolean, () => void, () => void] {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 2600)
    return () => clearTimeout(t)
  }, [armed])
  return [armed, () => setArmed(true), () => setArmed(false)]
}

// 就地编辑框：本地草稿 + 防抖落库，失焦 / ⌘Enter 收起并把没保存的补写出去。
// 不直接绑定共享镜像——每个按键都落库再重读，快速输入时迟到的旧值会把输入框盖回去
function InlineEditor({
  initial,
  placeholder,
  onSave,
  onDone
}: {
  initial: string
  placeholder: string
  onSave: (v: string) => Promise<void>
  onDone: () => void
}): JSX.Element {
  const [value, setValue] = useState(initial)
  const latest = useRef(value)
  latest.current = value
  const saved = useRef(initial)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    if (value === saved.current) return
    const t = setTimeout(() => {
      saved.current = value
      void saveRef.current(value)
    }, 450)
    return () => clearTimeout(t)
  }, [value])
  useEffect(
    () => () => {
      const last = latest.current
      if (last !== saved.current) void saveRef.current(last)
    },
    []
  )
  const finish = (): void => {
    const last = latest.current
    if (last !== saved.current) {
      saved.current = last
      void saveRef.current(last)
    }
    doneRef.current()
  }
  return (
    <textarea
      autoFocus
      className="np-inline"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          finish()
        } else if (e.key === 'Escape') doneRef.current()
      }}
    />
  )
}

export default function NotesPanel({
  paper,
  anns,
  notes,
  page,
  onJump
}: {
  paper: Paper
  anns: Highlight[]
  notes: Note[]
  page: number
  // 跳到某页；id >= 0 时定位到那条批注并让它闪一下
  onJump: (page: number, id: number) => void
}): JSX.Element {
  const whole = notes.find((n) => n.page == null)
  const wholeText = whole?.content ?? ''
  // 全文笔记的本地草稿（整篇一条）：改动防抖落库
  const [draft, setDraft] = useState(wholeText)
  const [saved, setSaved] = useState(true)
  const [err, setErr] = useState('')
  useEffect(() => {
    // 别处改了整篇笔记（镜像刷新）而本地没有未保存的改动时，草稿跟上
    setDraft((d) => (d === wholeText ? d : saved ? wholeText : d))
  }, [wholeText])
  useEffect(() => {
    if (draft === wholeText) return
    setSaved(false)
    const t = setTimeout(() => {
      void upsertNote({ page: null, content: draft })
      setSaved(true)
    }, 600)
    return () => clearTimeout(t)
  }, [draft, wholeText])
  // 切走 / 关掉面板前把没落库的草稿补写出去（卸载时直接走 IPC，不等镜像刷新）
  const latest = useRef({ draft, wholeText, paperId: paper.id })
  latest.current = { draft, wholeText, paperId: paper.id }
  useEffect(
    () => () => {
      const { draft: d, wholeText: w, paperId } = latest.current
      if (d !== w) void window.api.saveNote({ paperId, page: null, content: d }).catch(() => {})
    },
    []
  )

  // 就地编辑：批注文字 / 页面笔记（`a{id}` / `n{id}`）
  const [editing, setEditing] = useState<string | null>(null)
  const [addingPage, setAddingPage] = useState(false)

  // AI 整理：把批注与笔记交给模型归纳
  const reason = useReasoning()
  const [summary, setSummary] = useState<{ busy: boolean; text: string } | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const summarize = (): void => {
    if (summary?.busy) return
    setErr('')
    reason.clear()
    setSummary({ busy: true, text: '' })
    stopRef.current = window.api.stream(
      { mode: 'notes', paperId: paper.id },
      {
        onReason: reason.onReason,
        onDelta: (d) => {
          reason.clear()
          setSummary((s) => ({ busy: true, text: (s?.text ?? '') + d }))
        },
        onEnd: () => {
          reason.clear()
          setSummary((s) => (s ? { ...s, busy: false } : s))
        }
      }
    )
  }

  const [delArmed, armDel, disarmDel] = useConfirm()
  const pageNotes = notes.filter((n) => n.page != null)
  const hasContent = anns.length > 0 || pageNotes.some((n) => n.content.trim())

  const exportMd = async (): Promise<void> => {
    const r = await window.api.exportNotes(paper.id)
    setErr(!r.ok && r.error ? `导出失败：${r.error}` : '')
  }

  return (
    <div className="notes-panel">
      <div className="np-scroll">
        <div className="np-actions">
          <button className="np-btn" onClick={summarize} disabled={summary?.busy || !hasContent} title="把本篇的批注与笔记交给 AI 归纳成结构化的阅读笔记">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" />
              <path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3z" />
            </svg>
            AI 整理
          </button>
          <button className="np-btn" onClick={() => void exportMd()} disabled={!hasContent} title="批注与笔记导出为 Markdown 文件">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15V3M7.5 7.5L12 3l4.5 4.5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
            </svg>
            导出 Markdown
          </button>
          <span className="np-stat ellipsis">
            {anns.length} 批注 · {pageNotes.length} 页面笔记
          </span>
        </div>

        <div className="np-card">
          <div className="np-card-head">
            全文笔记
            <span className={`np-save ${saved ? '' : 'pending'}`}>{saved ? '已保存' : '保存中…'}</span>
          </div>
          <textarea
            className="np-textarea"
            value={draft}
            spellCheck={false}
            placeholder="对这篇论文的整体想法、结论、与其它工作的关联、待办…（自动保存）"
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>

        {summary && (
          <div className="np-card np-summary">
            <div className="np-card-head">
              AI 整理
              <span style={{ flex: 1 }} />
              {!summary.busy && summary.text.trim() && (
                <>
                  <button
                    className="np-mini"
                    title="把整理结果追加到全文笔记末尾"
                    onClick={() => {
                      setDraft((d) => `${d.trim() ? `${d.trimEnd()}\n\n` : ''}${summary.text.trim()}\n`)
                      setSummary(null)
                    }}
                  >
                    追加到全文笔记
                  </button>
                  <button className="np-mini" onClick={() => void navigator.clipboard.writeText(summary.text).catch(() => {})}>
                    复制
                  </button>
                </>
              )}
              <button
                className="np-mini"
                title={summary.busy ? '停止生成' : '收起'}
                onClick={() => {
                  if (summary.busy) stopRef.current?.()
                  setSummary(null)
                }}
              >
                {summary.busy ? '停止' : '收起'}
              </button>
            </div>
            {reason.text ? (
              <ReasonStrip text={reason.text} />
            ) : summary.text.trim() ? (
              <div className="np-md">
                <div className="bubble">{renderRich(summary.text, undefined, noopJump)}</div>
              </div>
            ) : (
              <div className="np-dim">正在整理…</div>
            )}
          </div>
        )}
        {err && <div className="np-err">{err}</div>}

        <div className="np-addrow">
          <button
            className="np-add"
            disabled={addingPage}
            onClick={() => {
              setEditing(null)
              setAddingPage(true)
            }}
          >
            ＋ 第 {page} 页笔记
          </button>
        </div>
        {addingPage && (
          <div className="np-item note new">
            <span className="np-bar note" />
            <div className="np-body">
              {/* 留空失焦 = 不建（主进程把空白笔记视同删除） */}
              <InlineEditor
                initial=""
                placeholder={`第 ${page} 页的要点、疑问…（自动保存，留空则不建）`}
                onSave={(v) => upsertNote({ page, content: v })}
                onDone={() => setAddingPage(false)}
              />
            </div>
            <span className="np-page">p.{page}</span>
          </div>
        )}

        <div className="np-list">
          {!hasContent && !addingPage && (
            <div className="np-empty">
              在 PDF 里<b>划词后点「笔记」</b>，即可给这段原文写批注；点已高亮的地方可以改颜色、补写或删除。
              <br />
              页面笔记不绑定原文，适合记整页的要点：用上面的按钮新建，之后点页面右上角的笔记标记就地编辑。
            </div>
          )}
          {anns.map((a) => (
            <div key={`a${a.id}`} className="np-item ann" data-color={a.color}>
              <span className="np-bar" title={HL_COLOR_NAME[a.color]} />
              <div className="np-body">
                <div className={`np-quote ${a.text.trim() ? '' : 'empty'}`} title="点击跳回原文" onClick={() => onJump(a.page, a.id)}>
                  {a.text.trim() || '（原文未记录）'}
                </div>
                {editing === `a${a.id}` ? (
                  <InlineEditor initial={a.note} placeholder="写下想法…（自动保存）" onSave={(v) => updateAnnotation(a.id, { note: v })} onDone={() => setEditing(null)} />
                ) : a.note.trim() ? (
                  <div className="np-note" title="点击编辑批注" onClick={() => setEditing(`a${a.id}`)}>
                    {a.note}
                  </div>
                ) : (
                  <button className="np-note add" onClick={() => setEditing(`a${a.id}`)}>
                    ＋ 添加批注
                  </button>
                )}
              </div>
              <button className="np-page" title={`跳到第 ${a.page} 页`} onClick={() => onJump(a.page, a.id)}>
                p.{a.page}
              </button>
              <DelButton armed={delArmed} hint="删除这条高亮（含批注）" onArm={armDel} onConfirm={() => void removeAnnotation(a.id)} />
            </div>
          ))}
          {pageNotes.map((n) => (
            <div key={`n${n.id}`} className="np-item note">
              <span className="np-bar note" />
              <div className="np-body">
                {editing === `n${n.id}` ? (
                  <InlineEditor
                    initial={n.content}
                    placeholder="这一页的要点、疑问…"
                    onSave={(v) => upsertNote({ id: n.id, page: n.page, content: v })}
                    onDone={() => setEditing(null)}
                  />
                ) : (
                  <div className="np-note" title="点击编辑" onClick={() => setEditing(`n${n.id}`)}>
                    {n.content}
                  </div>
                )}
              </div>
              <button className="np-page" title={`跳到第 ${n.page} 页`} onClick={() => onJump(n.page!, -1)}>
                p.{n.page}
              </button>
              <DelButton armed={delArmed} hint="删除这条笔记" onArm={armDel} onConfirm={() => void removeNote(n.id)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// 删除按钮：第一次点进入待确认（2.6 秒内再点才真删），其余条目的按钮同时显示待确认态
function DelButton({ armed, hint, onArm, onConfirm }: { armed: boolean; hint: string; onArm: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <button
      className={`np-del ${armed ? 'confirm' : ''}`}
      title={armed ? '再点一次确认删除' : hint}
      onClick={() => {
        if (armed) onConfirm()
        else onArm()
      }}
    >
      {armed ? '确认?' : '✕'}
    </button>
  )
}
