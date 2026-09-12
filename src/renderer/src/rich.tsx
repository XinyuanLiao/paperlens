import type { ReactNode } from 'react'
import type { SourceRef } from './types'

type Jump = (slug: string, page: number) => void

// 行内：markdown 链接 / 引用 [n] 芯片 / **bold** / `code`
function inline(text: string, keyBase: string, sources: SourceRef[] | undefined, onJump: Jump): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\[(\d+)\])|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (m[2]) {
      const src = sources?.find((s) => s.n === parseInt(m[2]))
      if (src) {
        out.push(
          <span key={`${keyBase}-${k++}`} className="cite-chip" title={`${src.title} · 第 ${src.page} 页`} onClick={() => onJump(src.slug, src.page)}>
            [{src.n}] p.{src.page}
          </span>
        )
      } else out.push(tok)
    } else if (m[3]) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!
      const label = lm[1]
      const url = lm[2]
      out.push(
        /^https?:\/\//.test(url) ? (
          <a key={`${keyBase}-${k++}`} className="md-link" href={url} onClick={(e) => { e.preventDefault(); window.api.openExternal(url) }}>
            {label}
          </a>
        ) : (
          <span key={`${keyBase}-${k++}`}>{label}</span>
        )
      )
    } else if (tok.startsWith('**')) out.push(<strong key={`${keyBase}-${k++}`}>{tok.slice(2, -2)}</strong>)
    else out.push(<code key={`${keyBase}-${k++}`} className="md-code">{tok.slice(1, -1)}</code>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
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
