// 参考文献解析与点击命中：
// ① buildRefIndex —— 从 PDF 文本重建 References 条目（编号 / 原文 / 各行 key），供弹窗查询元数据；
// ② resolveRefClick —— 把一次渲染端点击解析成「行内引用标记 [n] 的具体编号」或「文献表条目行」。
// 两侧共用同一套行重建逻辑（getTextContent 与 textLayer 同源、disableNormalization 同口径），
// 行 key 归一化后才能跨源对上。支持 [n] / (n) / n. 三种编号风格；两栏页按栏间隙拆段、左栏先读。

export interface RefEntry {
  num: number
  raw: string
  page: number
  // 该条目覆盖的每一行的归一化 key（起始行 + 续行）：点击文献表任意行都能反查条目
  lineKeys: string[]
}

export interface RefIndex {
  entries: RefEntry[]
  byNum: Map<number, RefEntry>
  byLine: Map<string, RefEntry>
  // 文献表覆盖的页码集合：悬停预过滤用（非这些页且 span 不含 [n] 形态就免装配）
  pages: Set<number>
  parsed: boolean
}

// 全角数字/括号转半角（中文文献表的 ［１２］（１） 等），再做 key 归一化——
// 解析侧（PDF 坐标）与命中侧（DOM）都必须先过这一步，key 才能一致
function fullWidth(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/［/g, '[')
    .replace(/］/g, ']')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/－/g, '-')
}

export function normKey(s: string): string {
  return fullWidth(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

interface PItem {
  str: string
  x: number
  y: number
  w: number
  h: number
}

interface Line {
  text: string
  page: number
}

// 条目起始编号：[12] / (12) 为强特征；「12.」弱特征（正文数字列表/小数点易误配），
// 要求后随大写字母或括号开头
const START_BR = /^[\[(](\d{1,4})[\])]\s*(.*)$/
const START_DOT = /^(\d{1,3})[.)]\s+(?=[A-Z\[(“"])(.+)$/

function joinLines(a: string, b: string): string {
  if (!a) return b
  if (/[a-zA-Z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b // 行尾断词连字符
  return `${a} ${b}`
}

// 一页 text items → 阅读序的行。视觉行按基线 y 聚类；行内按 x 排序后按「栏间隙」
// 拆段（栏间隙 ≈ 页宽 1.2%，远大于词间隙），两栏页左栏段落全部先于右栏
function itemsToLines(items: PItem[], page: number, pageW: number): Line[] {
  const its = items.filter((it) => it.str.trim().length > 0)
  if (!its.length) return []
  its.sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: PItem[][] = []
  for (const it of its) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(it.y - row[0].y) <= Math.max(2, Math.max(row[0].h, it.h) * 0.5)) row.push(it)
    else rows.push([it])
  }
  const gapLim = Math.max(2, pageW * 0.012)
  const segs: Array<{ text: string; y: number; x0: number }> = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    let cur: PItem[] = []
    const flush = (): void => {
      if (!cur.length) return
      let text = ''
      let prev: PItem | null = null
      for (const it of cur) {
        if (prev && it.x - (prev.x + prev.w) > Math.max(1, prev.h * 0.2) && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' '
        text += it.str
        prev = it
      }
      text = text.replace(/\s+/g, ' ').trim()
      if (text) segs.push({ text, y: cur[0].y, x0: cur[0].x })
      cur = []
    }
    for (const it of row) {
      if (cur.length) {
        const p = cur[cur.length - 1]
        if (it.x - (p.x + p.w) > gapLim) flush()
      }
      cur.push(it)
    }
    flush()
  }
  const mid = pageW * 0.45
  const left = segs.filter((s) => s.x0 < mid).sort((a, b) => b.y - a.y)
  const right = segs.filter((s) => s.x0 >= mid).sort((a, b) => b.y - a.y)
  const ordered = left.length >= 3 && right.length >= 3 ? [...left, ...right] : segs.sort((a, b) => b.y - a.y)
  return ordered.map((s) => ({ text: s.text, page }))
}

const HEADINGS = new Set(['references', 'reference', 'bibliography', '参考文献'])

function isHeading(text: string): boolean {
  const t = fullWidth(text)
    .toLowerCase()
    .replace(/[\s:：.。]+$/, '')
    .trim()
  return HEADINGS.has(t)
}

// 解析失败（无 References / 非编号风格）时 parsed=false，点击只做行内标记匹配
export async function buildRefIndex(doc: any): Promise<RefIndex> {
  const byNum = new Map<number, RefEntry>()
  const byLine = new Map<string, RefEntry>()
  const entries: RefEntry[] = []
  const pages = new Set<number>()
  try {
    const flat: Line[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n)
      const vp = pg.getViewport({ scale: 1 })
      const tc = await pg.getTextContent({ disableNormalization: true })
      const items = (tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>)
        .filter((it) => typeof it.str === 'string' && it.transform)
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height }))
      flat.push(...itemsToLines(items, n, vp.width))
    }
    // 取最后一次出现的标题（正文里引用「references」一词不会整行等值）
    let start = -1
    for (let i = 0; i < flat.length; i++) if (isHeading(flat[i].text)) start = i
    if (start < 0) return { entries, byNum, byLine, pages, parsed: false }
    for (let i = start + 1; i < flat.length; i++) pages.add(flat[i].page)
    let cur: RefEntry | null = null
    for (let i = start + 1; i < flat.length; i++) {
      const raw = fullWidth(flat[i].text).replace(/\s+/g, ' ').trim()
      if (!raw) continue
      if (/^(appendix|appendices|acknowledg|supplementary|supporting information)/i.test(raw)) break
      const mBr = START_BR.exec(raw)
      const mDot = mBr ? null : START_DOT.exec(raw)
      const m = mBr ?? mDot
      if (m) {
        const num = parseInt((mBr ?? mDot)![1])
        const rest = (mBr ?? mDot)![2].trim()
        const exist = byNum.get(num)
        if (exist) {
          cur = exist // 重号（解析误切）：续行并入已有条目
        } else {
          cur = { num, raw: rest, page: flat[i].page, lineKeys: [] }
          byNum.set(num, cur)
          entries.push(cur)
        }
      } else if (!cur) {
        continue // 标题与首个条目之间的杂行
      } else {
        cur.raw = joinLines(cur.raw, raw)
      }
      const key = normKey(raw)
      if (key && cur) cur.lineKeys.push(key)
    }
    for (const e of entries) for (const k of e.lineKeys) byLine.set(k, e)
  } catch {
    /* 解析失败不影响阅读 */
  }
  return { entries, byNum, byLine, pages, parsed: entries.length > 0 }
}

export interface ClickHit {
  // 行内标记命中的编号；点在条目行其余位置时为 null（调用方改用 lineText 反查）
  num: number | null
  lineText: string
}

// ---------- 行装配（点击与悬停共用同一核心，保证「高亮即所得」） ----------

// span 矩形缓存（wrap 相对坐标）：悬停每次 mousemove 都要装配行，不能反复读布局。
// 缩放/换文档时渲染端调 invalidateRefLayout() 前移版本号，缓存整体失效
let layoutVersion = 0
export function invalidateRefLayout(): void {
  layoutVersion++
}

interface CachedSpan {
  el: HTMLElement
  l: number
  t: number
  w: number
  h: number
}
const rectCache = new WeakMap<HTMLElement, { version: number; spans: CachedSpan[] }>()

function cachedSpans(wrap: HTMLElement): CachedSpan[] {
  let c = rectCache.get(wrap)
  if (!c || c.version !== layoutVersion) {
    const wrapRect = wrap.getBoundingClientRect()
    const spans: CachedSpan[] = []
    for (const el of [...wrap.querySelectorAll('.textLayer span')] as HTMLElement[]) {
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) continue
      spans.push({ el, l: r.left - wrapRect.left, t: r.top - wrapRect.top, w: r.width, h: r.height })
    }
    c = { version: layoutVersion, spans }
    rectCache.set(wrap, c)
  }
  return c.spans
}

interface Assembled {
  hitSpan: HTMLElement
  segText: string
  charX: number[]
  segRect: { x: number; y: number; w: number; h: number }
}

// 点击/悬停点 → 所在「栏内行」（同视觉行 spans 按栏间隙拆段），输出行文本、
// 字符→视口 x 映射（等宽近似，与全文搜索同思路）与段联合矩形
function assembleLine(cx: number, cy: number): Assembled | null {
  const cr = (document as any).caretRangeFromPoint?.(cx, cy) as Range | null
  if (!cr || !cr.startContainer) return null
  let node: Node | null = cr.startContainer
  if (node.nodeType === 3) node = node.parentNode
  const el = node as HTMLElement
  if (!el || el.tagName !== 'SPAN') return null
  const layer = el.closest('.textLayer') as HTMLElement | null
  const wrap = layer?.closest('.page-wrap') as HTMLElement | null
  if (!layer || !wrap) return null
  const cur = wrap.getBoundingClientRect()
  const spans = cachedSpans(wrap)
  const hit = spans.find((s) => s.el === el)
  if (!hit) return null
  const row = spans.filter((s) => Math.abs(s.t + s.h / 2 - (hit.t + hit.h / 2)) <= Math.max(3, Math.max(s.h, hit.h) * 0.6))
  if (!row.length) return null
  row.sort((a, b) => a.l - b.l)
  const gapLim = Math.max(8, cur.width * 0.012)
  const segs: CachedSpan[][] = []
  let seg: CachedSpan[] = []
  for (const s of row) {
    const prev = seg[seg.length - 1]
    if (prev && s.l - (prev.l + prev.w) > gapLim) {
      segs.push(seg)
      seg = []
    }
    seg.push(s)
  }
  segs.push(seg)
  const mine = segs.find((g) => g.some((s) => s.el === el))
  if (!mine) return null
  let segText = ''
  const charX: number[] = []
  let prev: CachedSpan | null = null
  for (const s of mine) {
    const str = s.el.textContent ?? ''
    if (prev && s.l - (prev.l + prev.w) > Math.max(1, prev.h * 0.2) && !/\s$/.test(segText) && !/^\s/.test(str)) segText += ' '
    const cw = s.w / Math.max(1, str.length)
    for (let c = 0; c < str.length; c++) {
      segText += str[c]
      charX.push(cur.left + s.l + (c + 0.5) * cw)
    }
    prev = s
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of mine) {
    const x = cur.left + s.l
    const y = cur.top + s.t
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + s.w)
    maxY = Math.max(maxY, y + s.h)
  }
  const segRect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  return { hitSpan: el, segText, charX, segRect }
}

// 行内标记匹配：点击点必须落在某个编号 token 附近；高亮/点击都取完整 [n] token 的矩形
function matchMarkerToken(
  segText: string,
  charX: number[],
  segRect: { y: number; h: number },
  cx: number
): { num: number; rect: { x: number; y: number; w: number; h: number } } | null {
  const re = /\[(\d{1,4}(?:\s*[-–—,;，；]\s*\d{1,4})*)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segText))) {
    const digits = /\d{1,4}/g
    let d: RegExpExecArray | null
    while ((d = digits.exec(m[1]))) {
      const a = m.index + 1 + d.index
      const b = a + d[0].length - 1
      if (cx >= charX[a] - 5 && cx <= charX[b] + 5) {
        const x0 = charX[m.index] - 3
        const x1 = charX[m.index + m[0].length - 1] + 3
        return { num: parseInt(d[0]), rect: { x: x0, y: segRect.y, w: Math.max(6, x1 - x0), h: segRect.h } }
      }
    }
  }
  return null
}

export function resolveRefClick(cx: number, cy: number): ClickHit | null {
  const a = assembleLine(cx, cy)
  if (!a) return null
  const token = matchMarkerToken(a.segText, a.charX, a.segRect, cx)
  return { num: token?.num ?? null, lineText: a.segText }
}

export interface HoverHit {
  rect: { x: number; y: number; w: number; h: number }
  span: HTMLElement
}

// 悬停命中：与点击同一套装配/匹配。索引未就绪或对应条目不存在时不亮（高亮即可点）。
// 预过滤避免绝大多数 mousemove 都装配整行：span 文本呈引用标记形态，或页在文献表范围内
export function resolveRefHover(cx: number, cy: number, index: RefIndex | null): HoverHit | null {
  if (!index || !index.parsed) return null
  const cr = (document as any).caretRangeFromPoint?.(cx, cy) as Range | null
  if (!cr || !cr.startContainer) return null
  let node: Node | null = cr.startContainer
  if (node.nodeType === 3) node = node.parentNode
  const el = node as HTMLElement
  if (!el || el.tagName !== 'SPAN') return null
  const wrap = el.closest?.('.page-wrap') as HTMLElement | null
  if (!wrap) return null
  const txt = el.textContent ?? ''
  const page = parseInt(wrap.dataset.page ?? '')
  const nearMarker = /\[\d{1,3}/.test(txt) || /^[\[\]0-9,，\u2013\u2014\-\s]{1,8}$/.test(txt)
  if (!nearMarker && !(page && index.pages.has(page))) return null
  const a = assembleLine(cx, cy)
  if (!a) return null
  const token = matchMarkerToken(a.segText, a.charX, a.segRect, cx)
  const entry = (token ? index.byNum.get(token.num) : undefined) ?? index.byLine.get(normKey(a.segText))
  if (!entry) return null
  return { rect: token ? token.rect : a.segRect, span: a.hitSpan }
}
