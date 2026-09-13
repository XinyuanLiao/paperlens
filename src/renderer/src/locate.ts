// 引用跳转的页内定位：用命中块原文（snippet）在目标页的文本项里找位置，
// 返回该段落在页面中的纵向比例区间，供滚动与高亮带使用。

export interface SnippetHit {
  top: number // 0..1，页面顶部到段落顶的占比
  height: number // 0..1，段落高度占比
}

// 归一化：去空白、小写、统一各种连字符变体，规避抽取时的排版差异
function normText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/[‐‑‒–—―]/g, '-')
}

export async function locateSnippet(doc: any, pageNum: number, snippet: string): Promise<SnippetHit | null> {
  if (!snippet || snippet.length < 20) return null
  const page = await doc.getPage(pageNum)
  const tc = await page.getTextContent()
  const items = (tc.items as Array<any>).filter((it) => typeof it.str === 'string' && it.str.length > 0)
  if (items.length === 0) return null

  // 拼出全页归一化文本，并记录每个文本项覆盖的字符区间
  let acc = ''
  const offs: Array<{ start: number; end: number; item: any }> = []
  for (const it of items) {
    const n = normText(it.str)
    if (!n) continue
    offs.push({ start: acc.length, end: acc.length + n.length, item: it })
    acc += n
  }

  const target = normText(snippet)
  // 从长到短多次尝试，长前缀定位准，短前缀容错好
  let idx = -1
  let len = 0
  for (const tryLen of [160, 100, 60, 36]) {
    const n = Math.min(tryLen, target.length)
    if (n < 20) continue
    const probe = target.slice(0, n)
    const hit = acc.indexOf(probe)
    if (hit >= 0) {
      idx = hit
      len = probe.length
      break
    }
  }
  if (idx < 0) return null

  let yMin = Infinity
  let yMax = -Infinity
  for (const o of offs) {
    if (o.end <= idx || o.start >= idx + len) continue
    const t = o.item.transform as number[]
    const y0 = t[5]
    const y1 = t[5] + (o.item.height || Math.abs(t[3]) || 8)
    if (y0 < yMin) yMin = y0
    if (y1 > yMax) yMax = y1
  }
  if (yMin === Infinity) return null

  const vp = page.getViewport({ scale: 1 })
  if (!vp.height) return null
  return {
    top: Math.max(0, (vp.height - yMax) / vp.height - 0.005),
    height: Math.min(1, (yMax - yMin) / vp.height + 0.01)
  }
}

// 在页面容器内放一条 2.6s 渐隐的高亮带（重复跳转时先清掉旧的）
export function flashHit(pageEl: HTMLElement, hit: SnippetHit): void {
  pageEl.querySelectorAll('.jump-hit').forEach((n) => n.remove())
  const band = document.createElement('div')
  band.className = 'jump-hit'
  band.style.top = `${hit.top * 100}%`
  band.style.height = `${Math.max(hit.height, 0.012) * 100}%`
  pageEl.appendChild(band)
  setTimeout(() => band.remove(), 2600)
}
