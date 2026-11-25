// 批注与笔记：数据读写 + Markdown 导出（纯 Node，不依赖 electron）。
//
// 批注（annotation）= 高亮 + 颜色 + 批注文字，存 highlights 表；
// 笔记（note）= 不绑定选区的自由文字，存 notes 表（page 为空 = 整篇笔记，每篇一条）。
// 两表都按 paper_id 归属论文，删论文时在 deletePaper 里一并清除
//（外键级联默认关闭，不能指望 REFERENCES ... ON DELETE CASCADE）

import { getDb } from './db'

export type HlColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'
export const HL_COLORS: HlColor[] = ['yellow', 'green', 'blue', 'pink', 'purple']

export interface HighlightRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Annotation {
  id: number
  page: number
  // 页面比例坐标（0..1）。损坏的旧数据可能为空数组——批注文字仍在笔记页可见
  rects: HighlightRect[]
  text: string
  color: HlColor
  note: string
  created_at: string
  updated_at: string | null
}

export interface Note {
  id: number
  paper_id: number
  page: number | null
  content: string
  updated_at: string
}

const QUOTE_MAX = 2000
const NOTE_MAX = 4000

// 颜色只认白名单：其余（含旧数据里的未知值）一律落回黄色
export const asColor = (c: unknown): HlColor => (HL_COLORS.includes(c as HlColor) ? (c as HlColor) : 'yellow')

interface HighlightRow {
  id: number
  page: number
  rects: string
  text: string
  color: string
  note: string | null
  created_at: string
  updated_at: string | null
}

function toAnnotation(r: HighlightRow): Annotation {
  let rects: HighlightRect[] = []
  try {
    const v = JSON.parse(r.rects)
    if (Array.isArray(v)) {
      rects = v.filter(
        (x): x is HighlightRect =>
          !!x && typeof x === 'object' && [x.x, x.y, x.w, x.h].every((n) => typeof n === 'number' && Number.isFinite(n))
      )
    }
  } catch {
    /* 矩形数据损坏：保留批注文字 */
  }
  return { id: r.id, page: r.page, rects, text: r.text ?? '', color: asColor(r.color), note: r.note ?? '', created_at: r.created_at, updated_at: r.updated_at }
}

export function listAnnotations(paperId: number): Annotation[] {
  const rows = getDb().prepare('SELECT * FROM highlights WHERE paper_id=? ORDER BY page, id').all(paperId) as HighlightRow[]
  return rows.map(toAnnotation)
}

export function addAnnotation(paperId: number, page: number, rects: HighlightRect[], text: string, color?: string): number {
  const r = getDb()
    .prepare("INSERT INTO highlights(paper_id,page,rects,text,color,note,updated_at) VALUES(?,?,?,?,?,'',datetime('now'))")
    .run(paperId, page, JSON.stringify(rects), String(text ?? '').slice(0, QUOTE_MAX), asColor(color))
  return Number(r.lastInsertRowid)
}

export function updateAnnotation(id: number, patch: { note?: string; color?: string }): boolean {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.note !== undefined) {
    sets.push('note=?')
    vals.push(String(patch.note).slice(0, NOTE_MAX))
  }
  if (patch.color !== undefined) {
    sets.push('color=?')
    vals.push(asColor(patch.color))
  }
  if (!sets.length) return true
  vals.push(id)
  const r = getDb().prepare(`UPDATE highlights SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...vals)
  return r.changes > 0
}

export function deleteAnnotation(id: number): boolean {
  return getDb().prepare('DELETE FROM highlights WHERE id=?').run(id).changes > 0
}

// ---------- 自由笔记 ----------

interface NoteRow {
  id: number
  paper_id: number
  page: number | null
  content: string
  updated_at: string
}

// 整篇笔记排最前，其余按页码、创建先后
export function listNotes(paperId: number): Note[] {
  return getDb()
    .prepare('SELECT id, paper_id, page, content, updated_at FROM notes WHERE paper_id=? ORDER BY (page IS NULL) DESC, page, id')
    .all(paperId) as NoteRow[]
}

// 新建或更新一条笔记。整篇笔记（page 为空）每篇只有一条，自动复用已有行。
// 存成空白内容等于删除——不让空笔记在清单里堆积。返回笔记 id，删除时返回 0
export function saveNote(input: { id?: number; paperId: number; page?: number | null; content: string }): number {
  const db = getDb()
  const paperId = Number(input.paperId)
  const content = String(input.content ?? '').slice(0, 50_000)
  const page = input.page == null ? null : Math.max(1, Number(input.page) || 1)
  const existing = page == null ? (db.prepare('SELECT id FROM notes WHERE paper_id=? AND page IS NULL').get(paperId) as { id: number } | undefined) : undefined
  const id = (existing?.id ?? Number(input.id)) || 0
  if (!content.trim()) {
    if (id) db.prepare('DELETE FROM notes WHERE id=? AND paper_id=?').run(id, paperId)
    return 0
  }
  if (id) {
    const r = db.prepare("UPDATE notes SET content=?, updated_at=datetime('now') WHERE id=? AND paper_id=?").run(content, id, paperId)
    if (r.changes > 0) return id
    // 给的 id 不属于这篇论文（或已被删除）：落到新建，绝不改到别的论文的笔记上
  }
  const r = db.prepare('INSERT INTO notes(paper_id,page,content) VALUES(?,?,?)').run(paperId, page, content)
  return Number(r.lastInsertRowid)
}

export function deleteNote(id: number): boolean {
  return getDb().prepare('DELETE FROM notes WHERE id=?').run(id).changes > 0
}

// 删除论文时调用：清掉它的全部批注与笔记
export function deletePaperAnnotations(paperId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM highlights WHERE paper_id=?').run(paperId)
  db.prepare('DELETE FROM notes WHERE paper_id=?').run(paperId)
}

export interface AnnotationCount {
  hl: number
  notes: number
}

// 各论文的批注 / 笔记条数（文献列表上的角标用）：只含确实有内容的论文
export function annotationCounts(): Map<number, AnnotationCount> {
  const out = new Map<number, AnnotationCount>()
  const get = (id: number): AnnotationCount => {
    let c = out.get(id)
    if (!c) out.set(id, (c = { hl: 0, notes: 0 }))
    return c
  }
  for (const r of getDb().prepare('SELECT paper_id, COUNT(*) AS n FROM highlights GROUP BY paper_id').all() as Array<{ paper_id: number; n: number }>) {
    get(r.paper_id).hl = r.n
  }
  for (const r of getDb().prepare('SELECT paper_id, COUNT(*) AS n FROM notes GROUP BY paper_id').all() as Array<{ paper_id: number; n: number }>) {
    get(r.paper_id).notes = r.n
  }
  return out
}

// ---------- Markdown 导出 ----------

export interface NotePaper {
  title: string
  authors: string
  venue: string
  year: number | null
}

// 笔记 + 批注 → 一份 Markdown：全文笔记在前，其余按页码归并（引用原文用引用块，批注紧随其后）
export function notesMarkdown(paper: NotePaper, anns: Annotation[], notes: Note[]): string {
  const lines: string[] = []
  const meta = [paper.authors, paper.venue, paper.year].filter(Boolean).join(' · ')
  lines.push(`# ${paper.title || '未命名文献'} · 笔记`, '')
  if (meta) lines.push(`> ${meta}`, '')
  lines.push(`> 由 PaperLens 导出 · ${new Date().toLocaleDateString('zh-CN')}`, '')
  const whole = notes.find((n) => n.page == null)
  if (whole?.content.trim()) lines.push('## 全文笔记', '', whole.content.trim(), '')

  const pages = new Map<number, { anns: Annotation[]; notes: Note[] }>()
  const pageOf = (p: number) => {
    let g = pages.get(p)
    if (!g) pages.set(p, (g = { anns: [], notes: [] }))
    return g
  }
  for (const a of anns) pageOf(a.page).anns.push(a)
  for (const n of notes) if (n.page != null && n.content.trim()) pageOf(n.page).notes.push(n)

  let any = !!whole?.content.trim()
  for (const [page, g] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`## 第 ${page} 页`, '')
    for (const a of g.anns) {
      any = true
      if (a.text.trim()) lines.push(...a.text.trim().split('\n').map((l) => `> ${l}`))
      if (a.note.trim()) lines.push('', a.note.trim())
      lines.push('')
    }
    for (const n of g.notes) {
      any = true
      lines.push(n.content.trim(), '')
    }
  }
  if (!any) lines.push('（还没有批注或笔记）', '')
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
