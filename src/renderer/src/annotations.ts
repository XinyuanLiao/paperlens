import { useSyncExternalStore } from 'react'
import type { Highlight, HighlightRect, HlColor, Note } from './types'

// 批注与笔记的渲染端共享状态。阅读器（画高亮、弹批注卡）、侧栏笔记页（列清单）、文献列表（角标）
// 用的是同一份数据：任何一处增删改，其余各处立即同步。
// 数据以主进程 SQLite 为准，这里只是镜像——每次写操作都先乐观更新镜像，再落库

// 颜色白名单与中文名（与主进程 src/main/notes.ts 同一份）
export const HL_COLORS: HlColor[] = ['yellow', 'green', 'blue', 'pink', 'purple']
export const HL_COLOR_NAME: Record<HlColor, string> = { yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色', purple: '紫色' }

// 上次用的高亮颜色：连续划词不必每次重选
const COLOR_KEY = 'pl.hlColor'
export function getLastColor(): HlColor {
  const v = localStorage.getItem(COLOR_KEY)
  return HL_COLORS.includes(v as HlColor) ? (v as HlColor) : 'yellow'
}
export function setLastColor(c: HlColor): void {
  localStorage.setItem(COLOR_KEY, c)
}

let annotations: Highlight[] = []
let notes: Note[] = []
let paperId: number | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((fn) => fn())
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useAnnotations(): Highlight[] {
  return useSyncExternalStore(subscribe, () => annotations, () => annotations)
}
export function useNotes(): Note[] {
  return useSyncExternalStore(subscribe, () => notes, () => notes)
}

// 换论文：清空旧镜像后拉取新论文的数据。序号防竞态——快速连点两篇时，迟到的旧结果不会盖住新论文
let loadSeq = 0
export async function loadAnnotations(id: number | null): Promise<void> {
  const seq = ++loadSeq
  paperId = id
  annotations = []
  notes = []
  emit()
  if (id == null) return
  try {
    const [hs, ns] = await Promise.all([window.api.listHighlights(id), window.api.listNotes(id)])
    if (seq !== loadSeq) return
    annotations = hs
    notes = ns
    emit()
  } catch {
    /* 读取失败保持空镜像：阅读不受影响，只是看不到已有批注 */
  }
}

const byPage = (a: Highlight, b: Highlight): number => a.page - b.page || a.id - b.id

// 新建批注（高亮 + 可选批注文字），返回镜像里的那条，便于阅读器立刻弹出批注卡
export async function addAnnotation(page: number, rects: HighlightRect[], text: string, color: HlColor): Promise<Highlight | null> {
  if (paperId == null) return null
  const id = await window.api.addHighlight(paperId, page, rects, text, color)
  const item: Highlight = { id, page, rects, text, color, note: '', created_at: '' }
  annotations = [...annotations, item].sort(byPage)
  emit()
  return item
}

export async function updateAnnotation(id: number, patch: { note?: string; color?: HlColor }): Promise<void> {
  if (!annotations.some((a) => a.id === id)) return
  annotations = annotations.map((a) => (a.id === id ? { ...a, ...patch } : a))
  emit()
  try {
    await window.api.updateHighlight(id, patch)
  } catch {
    /* 落库失败：镜像已是新值，下次打开论文会回到已落库的内容 */
  }
}

export async function removeAnnotation(id: number): Promise<void> {
  if (!annotations.some((a) => a.id === id)) return
  annotations = annotations.filter((a) => a.id !== id)
  emit()
  void window.api.deleteHighlight(id).catch(() => {})
}

// 新建或更新笔记。「空白即删除」「整篇笔记每篇一条」这些规则在主进程，
// 所以落库后以主进程返回的清单为准刷新镜像
export async function upsertNote(input: { id?: number; page: number | null; content: string }): Promise<void> {
  if (paperId == null) return
  await window.api.saveNote({ id: input.id, paperId, page: input.page, content: input.content })
  await reloadNotes()
}

export async function removeNote(id: number): Promise<void> {
  if (!notes.some((n) => n.id === id)) return
  notes = notes.filter((n) => n.id !== id)
  emit()
  await window.api.deleteNote(id).catch(() => {})
}

async function reloadNotes(): Promise<void> {
  if (paperId == null) return
  try {
    notes = await window.api.listNotes(paperId)
    emit()
  } catch {
    /* 刷新失败保持旧镜像 */
  }
}
