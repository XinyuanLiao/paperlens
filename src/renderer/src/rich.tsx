import type { ReactNode } from 'react'
import type { SourceRef } from './types'

type Jump = (slug: string, page: number) => void

// 行内：先按引用 [n] 切分出可点击芯片，其余片段再做 **bold** / `code`
function inline(text: string, keyBase: string, sources: SourceRef[] | undefined, onJump: Jump): ReactNode[] {
  const parts = text.split(/(\[\d+\])/g)
  return parts.map((p, i) => {
    const m = p.match(/^\[(\d+)\]$/)
    if (m && sources) {
      const src = sources.find((s) => s.n === parseInt(m[1]))
      if (src) {
        return (
          <span key={`${keyBase}-${i}`} className="cite-chip" title={`${src.title} · 第 ${src.page} 页`} onClick={() => onJump(src.slug, src.page)}>
            [{src.n}] p.{src.page}
          </span>
        )
      }
    }
    const out: ReactNode[] = []
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
    let last = 0
    let k = 0
    let mm: RegExpExecArray | null
    while ((mm = re.exec(p))) {
      if (mm.index > last) out.push(p.slice(last, mm.index))
      const tok = mm[0]
      if (tok.startsWith('**')) out.push(<strong key={`${keyBase}-${i}-${k++}`}>{tok.slice(2, -2)}</strong>)
      else out.push(<code key={`${keyBase}-${i}-${k++}`} className="md-code">{tok.slice(1, -1)}</code>)
      last = mm.index + tok.length
    }
    if (last < p.length) out.push(p.slice(last))
    return <span key={`${keyBase}-${i}`}>{out}</span>
  })
}

// 块级：### 标题 / --- 分割线 / - 与 1. 列表 / 普通段落
export function renderRich(content: string, sources: SourceRef[] | undefined, onJump: Jump): ReactNode {
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = (): void => {
    if (!list) return
    const L = list
    list = null
    const items = L.items.map((it, i) => <li key={i}>{inline(it, `l${blocks.length}-${i}`, sources, onJump)}</li>)
    blocks.push(L.ordered ? <ol key={blocks.length} className="md-list">{items}</ol> : <ul key={blocks.length} className="md-list">{items}</ul>)
  }
  for (const raw of content.split('\n')) {
    const t = raw.trim()
    if (/^[-*]\s+/.test(t)) {
      if (!list || list.ordered) flush()
      list = list ?? { ordered: false, items: [] }
      list.items.push(t.replace(/^[-*]\s+/, ''))
      continue
    }
    const om = t.match(/^(\d+)[.、)]\s+(.*)$/)
    if (om) {
      if (!list || !list.ordered) flush()
      list = list ?? { ordered: true, items: [] }
      list.items.push(om[2])
      continue
    }
    flush()
    if (!t) continue
    const hm = t.match(/^#{1,6}\s+(.*)$/)
    if (hm) {
      blocks.push(<div key={blocks.length} className="md-h">{inline(hm[1], `h${blocks.length}`, sources, onJump)}</div>)
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      blocks.push(<hr key={blocks.length} className="md-hr" />)
      continue
    }
    blocks.push(<p key={blocks.length} className="md-p">{inline(t, `p${blocks.length}`, sources, onJump)}</p>)
  }
  flush()
  return blocks
}
