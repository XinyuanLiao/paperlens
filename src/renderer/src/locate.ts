// 引用跳转的页内定位，三层递进：
// 1. 精确层：命中块原文（snippet）在目标页文本里做归一化子串匹配（多个长度 × 多个起点的探针）；
// 2. 模糊层：bigram Dice 相似度滑窗——同语言下少量字符差异 / 重排可兜住；
// 3. 关键词层（locateByKeywords）：跨语言场景（中文提问 ↔ 英文论文），用问题与回答上下文里的
//    英文术语 + 中文 bigram 在页内找密集命中窗口，可跨相邻页搜索。
// 返回段落覆盖的逐行矩形（页面比例），滚动用 top/height，高亮用 rects。

export interface SnippetRect {
  x: number // 0..1
  y: number // 0..1
  w: number
  h: number
}

export interface SnippetHit {
  top: number // 0..1，页面顶部到段落顶的占比
  height: number // 0..1，段落高度占比
  rects: SnippetRect[] // 逐行高亮矩形（比单条全宽带精准）
}

// 归一化：NFKD 分解连字/注音、去组合符，只保留字母数字与 CJK——
// 标点、空格、连字符变体、引号差异全部抹平，规避抽取时的排版差异
function normText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u00ad]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '')
}

interface PageText {
  acc: string
  offs: Array<{ start: number; end: number; item: any }>
  vp: { width: number; height: number }
}

async function pageText(doc: any, pageNum: number): Promise<PageText | null> {
  const page = await doc.getPage(pageNum)
  const tc = await page.getTextContent()
  const items = (tc.items as Array<any>).filter((it) => typeof it.str === 'string' && it.str.length > 0)
  if (items.length === 0) return null
  let acc = ''
  const offs: PageText['offs'] = []
  for (const it of items) {
    const n = normText(it.str)
    if (!n) continue
    offs.push({ start: acc.length, end: acc.length + n.length, item: it })
    acc += n
  }
  const vp = page.getViewport({ scale: 1 })
  if (!vp.height || !acc) return null
  return { acc, offs, vp }
}

// 精确层：长探针定位准，短探针容错好；多个起点兜住"命中内容在块中后部"的情况
function exactRange(acc: string, target: string): { idx: number; len: number } | null {
  if (target.length < 20) return null
  const lens = [200, 120, 70, 40]
  for (const len of lens) {
    if (len > target.length) continue
    for (const off of [0, Math.floor(target.length / 4), Math.floor(target.length / 2)]) {
      const probe = target.slice(off, off + len)
      if (probe.length < 20) continue
      const hit = acc.indexOf(probe)
      if (hit >= 0) return { idx: hit, len: probe.length }
    }
  }
  return null
}

// 模糊层：滑窗 bigram 重合率（Dice）。中文按字 bigram、英文按跨词 bigram，均可比
function fuzzyRange(acc: string, target: string): { idx: number; len: number } | null {
  if (target.length < 30) return null
  const w = Math.min(target.length, 200)
  const t = target.slice(0, w)
  const tb = new Map<string, number>()
  for (let i = 0; i + 1 < t.length; i++) {
    const bg = t.slice(i, i + 2)
    tb.set(bg, (tb.get(bg) ?? 0) + 1)
  }
  const total = t.length - 1
  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i + w <= acc.length; i += 10) {
    const win = acc.slice(i, i + w)
    const wb = new Map<string, number>()
    for (let j = 0; j + 1 < w; j++) {
      const bg = win.slice(j, j + 2)
      wb.set(bg, (wb.get(bg) ?? 0) + 1)
    }
    let inter = 0
    for (const [bg, n] of tb) {
      const m = wb.get(bg)
      if (m) inter += Math.min(n, m)
    }
    const score = inter / total
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  return bestScore >= 0.66 ? { idx: bestIdx, len: w } : null
}

// 字符区间 → 覆盖的文本项 → 按基线 y 聚成行 → 每行一个矩形（x 起止、y 起止，页面比例）
function hitFromRange(pt: PageText, idx: number, len: number): SnippetHit | null {
  const matched = pt.offs.filter((o) => o.end > idx && o.start < idx + len)
  if (!matched.length) return null
  const sorted = [...matched].sort((a, b) => ((b.item.transform?.[5] ?? 0) - (a.item.transform?.[5] ?? 0)))
  const rows: Array<Array<(typeof matched)[number]>> = []
  for (const o of sorted) {
    const y = o.item.transform?.[5] ?? 0
    const tol = Math.max(2, (o.item.height || 8) * 0.45)
    const row = rows[rows.length - 1]
    if (row && Math.abs((row[0].item.transform?.[5] ?? 0) - y) <= tol) row.push(o)
    else rows.push([o])
  }
  const vpW = pt.vp.width
  const vpH = pt.vp.height
  const rects: SnippetRect[] = []
  for (const row of rows) {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const o of row) {
      const t = o.item.transform as number[]
      const h = o.item.height || Math.abs(t[3]) || 8
      const w = o.item.width || o.item.str.length * Math.abs(t[0]) * 0.5
      x0 = Math.min(x0, t[4])
      x1 = Math.max(x1, t[4] + w)
      y0 = Math.min(y0, t[5])
      y1 = Math.max(y1, t[5] + h)
    }
    if (x1 <= x0) continue
    const x = Math.max(0, x0 / vpW)
    const w = Math.min(1 - x, (x1 - x0) / vpW)
    const y = Math.max(0, (vpH - y1) / vpH)
    const h = Math.min(1 - y, (y1 - y0) / vpH)
    if (w > 0.002 && h > 0.002) rects.push({ x, y, w, h })
  }
  if (!rects.length) return null
  const top = Math.min(...rects.map((r) => r.y))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { top, height: bottom - top, rects }
}

// 精确 + 模糊（同语言）：snippet 来自索引分块，目标页来自同一抽取管线，通常精确命中
export async function locateSnippet(doc: any, pageNum: number, snippet: string): Promise<SnippetHit | null> {
  if (!snippet || snippet.length < 20) return null
  const pt = await pageText(doc, pageNum).catch(() => null)
  if (!pt) return null
  const target = normText(snippet)
  const r = exactRange(pt.acc, target) ?? fuzzyRange(pt.acc, target)
  return r ? hitFromRange(pt, r.idx, r.len) : null
}

// 关键词层（跨语言）：整篇问答模式没有 snippet，模型只给页码——用「用户问题 + 回答里
// 引用处上下文」的英文术语 / 中文 bigram 在页内找密集窗口；顺带搜索相邻页兜住页码误差
export interface KeywordHit {
  page: number
  hit: SnippetHit
}

const KW_STOP = new Set([
  'the', 'and', 'for', 'are', 'with', 'this', 'that', 'from', 'have', 'has', 'had', 'was', 'were', 'will',
  'can', 'could', 'its', 'their', 'than', 'then', 'when', 'what', 'which', 'how', 'why', 'does', 'did',
  'not', 'but', 'all', 'any', 'into', 'over', 'between', 'based', 'using', 'used', 'use', 'via', 'about',
  'you', 'your', 'there', 'these', 'those', 'some', 'such', 'may', 'also', 'should', 'would', '是否', '什么',
  '怎么', '怎样', '如何', '哪些', '这个', '那个', '可以', '一个', '论文', '文献', '这篇', '库中', '主要',
  '以及', '并且', '还是', '对于'
])

export async function locateByKeywords(doc: any, pageNum: number, text: string): Promise<KeywordHit | null> {
  if (!text) return null
  const probe = text.slice(0, 500)
  const toks: string[] = []
  const seen = new Set<string>()
  for (const w of probe.match(/[A-Za-z][A-Za-z0-9+-]{2,}/g) ?? []) {
    const t = w.toLowerCase()
    if (!KW_STOP.has(t) && !seen.has(t)) {
      seen.add(t)
      toks.push(t)
    }
  }
  for (const seg of probe.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const bg = seg.slice(i, i + 2)
      if (!seen.has(bg)) {
        seen.add(bg)
        toks.push(bg)
      }
    }
  }
  if (toks.length === 0) return null
  const kw = toks.slice(0, 24)
  const numPages = doc.numPages as number
  const pts = new Map<number, PageText>()
  let best: { page: number; score: number; idx: number } = { page: 0, score: 0, idx: 0 }
  for (const pg of [pageNum, pageNum - 1, pageNum + 1]) {
    if (pg < 1 || pg > numPages) continue
    const pt = await pageText(doc, pg).catch(() => null)
    if (!pt) continue
    pts.set(pg, pt)
    const w = 240
    for (let i = 0; i < pt.acc.length; i += 48) {
      const win = pt.acc.slice(i, i + w)
      let hits = 0
      for (const tk of kw) if (win.includes(tk)) hits++
      // 严格大于：平分时目标页优先
      if (hits > best.score) best = { page: pg, score: hits, idx: i }
    }
  }
  const need = Math.max(2, Math.ceil(kw.length * 0.18))
  if (best.score < need) return null
  const pt = pts.get(best.page)!
  const hit = hitFromRange(pt, best.idx, Math.min(240, pt.acc.length - best.idx))
  return hit ? { page: best.page, hit } : null
}

// 在页面容器内放若干条 2.6s 渐隐的逐行高亮带（重复跳转时先清掉旧的）
export function flashHit(pageEl: HTMLElement, hit: SnippetHit): void {
  pageEl.querySelectorAll('.jump-hit').forEach((n) => n.remove())
  const rects = hit.rects.length ? hit.rects : [{ x: 0, y: hit.top, w: 1, h: Math.max(hit.height, 0.012) }]
  for (const r of rects) {
    const band = document.createElement('div')
    band.className = 'jump-hit'
    band.style.left = `${r.x * 100}%`
    band.style.width = `${r.w * 100}%`
    band.style.top = `${r.y * 100}%`
    band.style.height = `${Math.max(r.h, 0.012) * 100}%`
    pageEl.appendChild(band)
    setTimeout(() => band.remove(), 2600)
  }
}
