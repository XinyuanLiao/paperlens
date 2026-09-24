import { useState } from 'react'
import type { ReactNode } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import type { SourceRef } from './types'

// ---------- 公式（KaTeX 渲染，失败回退原文斜体） ----------
function texHtml(tex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: 'html', strict: 'ignore' })
  } catch {
    return null
  }
}

function MathSpan({ tex }: { tex: string }): JSX.Element {
  const html = texHtml(tex, false)
  return html ? (
    <span className="md-math" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="md-math md-math-raw">{tex}</span>
  )
}

function MathBlock({ tex }: { tex: string }): JSX.Element {
  const html = texHtml(tex, true)
  return html ? (
    <div className="md-mathblock" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <div className="md-mathblock md-math-raw">{tex}</div>
  )
}

// 引用跳转：ctx = 引用芯片所在回答里的上下文（前后文），read 模式整篇问答没有
// snippet 时用它 + 问题做关键词定位
export type Jump = (slug: string, page: number, snippet?: string, ctx?: string) => void

// ---------- 代码块（带语言标签与复制） ----------

function CodeBlock({ lang, code }: { lang: string; code: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = code
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* 忽略 */
      }
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="md-codeblock">
      <div className="md-code-head">
        <span>{lang || 'code'}</span>
        <button className="md-copy" onClick={() => void copy()}>
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  )
}

// ---------- 行内元素：引用芯片 / 链接 / 粗体 / 斜体 / 行内码 / 删除线 / $公式$ ----------

// 顺序敏感：[n] 引用 → 链接 → **粗** → ~~删~~ → `码` → $公式$ / \(公式\) → *斜*
function inline(text: string, keyBase: string, sources: SourceRef[] | undefined, onJump: Jump, depth = 0): ReactNode[] {
  const out: ReactNode[] = []
  const re =
    /(\[(\d+)\])|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*(?=\S)[^*]*?\S\*\*)|(~~(?=\S)[^~]+~~)|(`[^`\n]+`)|(\$(?=\S)[^$\n]*\S\$)|(\\\(.+?\\\))|(\*(?=[^\s*])[^*\n]*?\S\*)/g
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (m[2]) {
      const citeN = parseInt(m[2])
      const src = sources?.find((s) => s.n === citeN)
      if (src) {
        // 芯片随身携带它在回答里的局部上下文：整篇问答（无 snippet）时用它做关键词定位
        const ctx = text.slice(Math.max(0, m.index - 140), m.index + 160)
        const sec = src.sectionNo || src.sectionTitle ? ` §${[src.sectionNo, src.sectionTitle].filter(Boolean).join(' ')}` : ''
        out.push(
          <span
            key={`${keyBase}-c${k++}`}
            className="cite-chip"
            title={`${src.title}${sec} · 第 ${src.page} 页（跳到原文）`}
            onClick={() => onJump(src.slug, src.page, src.snippet, ctx)}
          >
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
          <a key={`${keyBase}-l${k++}`} className="md-link" href={url} onClick={(e) => { e.preventDefault(); window.api.openExternal(url) }}>
            {label}
          </a>
        ) : (
          <span key={`${keyBase}-l${k++}`}>{label}</span>
        )
      )
    } else if (tok.startsWith('**')) {
      const inner = tok.slice(2, -2)
      out.push(<strong key={`${keyBase}-b${k++}`}>{depth < 2 ? inline(inner, `${keyBase}-b${k}`, sources, onJump, depth + 1) : inner}</strong>)
    } else if (tok.startsWith('~~')) {
      out.push(
        <span key={`${keyBase}-d${k++}`} className="md-del">
          {tok.slice(2, -2)}
        </span>
      )
    } else if (tok.startsWith('`')) {
      out.push(
        <code key={`${keyBase}-k${k++}`} className="md-code">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('$')) {
      out.push(<MathSpan key={`${keyBase}-m${k++}`} tex={tok.slice(1, -1)} />)
    } else if (tok.startsWith('\\(')) {
      out.push(<MathSpan key={`${keyBase}-m${k++}`} tex={tok.slice(2, -2)} />)
    } else {
      const inner = tok.slice(1, -1)
      out.push(<em key={`${keyBase}-i${k++}`}>{depth < 2 ? inline(inner, `${keyBase}-i${k}`, sources, onJump, depth + 1) : inner}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// ---------- 列表（两级嵌套） ----------

interface LiNode {
  text: string
  ordered: boolean
  children: LiNode[]
}

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.、)])\s+(.+)$/

function parseListBlock(lines: string[], start: number): { nodes: LiNode[]; end: number } {
  const flat: Array<{ depth: number; ordered: boolean; text: string }> = []
  let i = start
  while (i < lines.length) {
    const raw = lines[i]
    if (!raw.trim()) {
      // 列表中间的空行：下一行仍是列表项则并入，否则列表结束
      if (i + 1 < lines.length && LIST_RE.test(lines[i + 1])) {
        i++
        continue
      }
      break
    }
    const m = raw.match(LIST_RE)
    if (!m) {
      // 缩进续行：并进上一项
      if (flat.length && /^\s+\S/.test(raw)) {
        flat[flat.length - 1].text += ` ${raw.trim()}`
        i++
        continue
      }
      break
    }
    const indent = m[1].replace(/\t/g, '  ').length
    flat.push({ depth: Math.min(3, Math.floor(indent / 2)), ordered: /^\d/.test(m[2]), text: m[3] })
    i++
  }
  const nodes: LiNode[] = []
  const stack: Array<{ depth: number; node: LiNode }> = []
  for (const it of flat) {
    const node: LiNode = { text: it.text, ordered: it.ordered, children: [] }
    while (stack.length && stack[stack.length - 1].depth >= it.depth) stack.pop()
    if (!stack.length) nodes.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ depth: it.depth, node })
  }
  return { nodes, end: i }
}

function renderListLevel(nodes: LiNode[], key: string, sources: SourceRef[] | undefined, onJump: Jump): ReactNode {
  const out: JSX.Element[] = []
  let i = 0
  while (i < nodes.length) {
    const ordered = nodes[i].ordered
    const group: LiNode[] = []
    while (i < nodes.length && nodes[i].ordered === ordered) {
      group.push(nodes[i])
      i++
    }
    const Tag = ordered ? 'ol' : 'ul'
    out.push(
      <Tag key={`${key}-g${out.length}`} className="md-list">
        {group.map((n, gi) => (
          <li key={`${key}-g${out.length}-${gi}`}>
            {inline(n.text, `${key}-g${out.length}-${gi}`, sources, onJump)}
            {n.children.length > 0 && renderListLevel(n.children, `${key}-g${out.length}-${gi}-c`, sources, onJump)}
          </li>
        ))}
      </Tag>
    )
  }
  return out.length === 1 ? out[0] : <>{out}</>
}

// ---------- 块级渲染 ----------

// 支持：```代码块``` / > 引用块 / #~###### 标题 / 有序无序嵌套列表 / 表格 / --- 分割线 /
// $$公式块$$ / 段落（单换行转 <br>）/ 行内粗斜码删链公式 / [n] 引用芯片
export function renderRich(content: string, sources: SourceRef[] | undefined, onJump: Jump): ReactNode {
  const blocks: ReactNode[] = []
  const lines = content.split('\n')
  let li = 0
  const para: string[] = []
  const flushPara = (): void => {
    if (!para.length) return
    const key = `p${blocks.length}`
    blocks.push(
      <p key={key} className="md-p">
        {para.map((seg, si) => (
          <span key={si}>
            {si > 0 && <br />}
            {inline(seg, `${key}-${si}`, sources, onJump)}
          </span>
        ))}
      </p>
    )
    para.length = 0
  }

  while (li < lines.length) {
    const t = lines[li].trim()

    if (!t) {
      flushPara()
      li++
      continue
    }

    // 围栏代码块（流式未收尾时也照常渲染已到的内容）
    if (t.startsWith('```')) {
      flushPara()
      const lang = t.slice(3).trim()
      const code: string[] = []
      li++
      while (li < lines.length && !lines[li].trim().startsWith('```')) {
        code.push(lines[li])
        li++
      }
      if (li < lines.length) li++
      blocks.push(<CodeBlock key={`cb${blocks.length}`} lang={lang} code={code.join('\n')} />)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushPara()
      blocks.push(<hr key={`hr${blocks.length}`} className="md-hr" />)
      li++
      continue
    }

    // 引用块
    if (/^>/.test(t)) {
      flushPara()
      const q: string[] = []
      while (li < lines.length && /^>/.test(lines[li].trim())) {
        q.push(lines[li].trim().replace(/^>\s?/, ''))
        li++
      }
      blocks.push(
        <blockquote key={`q${blocks.length}`} className="md-quote">
          {renderRich(q.join('\n'), sources, onJump)}
        </blockquote>
      )
      continue
    }

    // 表格
    if (t.startsWith('|')) {
      flushPara()
      const tl: string[] = []
      while (li < lines.length && lines[li].trim().startsWith('|')) {
        tl.push(lines[li].trim())
        li++
      }
      const cells = tl
        .filter((l) => !/^\|[\s:|-]*\|?$/.test(l))
        .map((l) => l.slice(1, l.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim()))
      if (cells.length) {
        const head = cells[0]
        const body = cells.slice(1)
        blocks.push(
          <table key={`t${blocks.length}`} className="md-table">
            <thead>
              <tr>{head.map((c, ci) => <th key={ci}>{inline(c, `t${blocks.length}h${ci}`, sources, onJump)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `t${blocks.length}b${ri}-${ci}`, sources, onJump)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )
      }
      continue
    }

    // 标题（容忍尾部 # 装饰）
    const hm = t.match(/^(#{1,6})\s+(.*?)(?:\s+#+)?$/)
    if (hm) {
      flushPara()
      blocks.push(
        <div key={`h${blocks.length}`} className={`md-h md-h${Math.min(hm[1].length, 3)}`}>
          {inline(hm[2], `h${blocks.length}`, sources, onJump)}
        </div>
      )
      li++
      continue
    }

    // 独立公式块 $$…$$（单行或多行围栏）
    if (t.startsWith('$$')) {
      flushPara()
      const oneLine = /\$\$/.test(t.slice(2))
      if (oneLine) {
        blocks.push(<MathBlock key={`m${blocks.length}`} tex={t.slice(2).replace(/\$\$$/, '').trim()} />)
        li++
      } else {
        const parts: string[] = [t.slice(2)]
        li++
        while (li < lines.length && !lines[li].trim().endsWith('$$')) {
          parts.push(lines[li])
          li++
        }
        if (li < lines.length) {
          parts.push(lines[li].trim().replace(/\$\$$/, ''))
          li++
        }
        blocks.push(<MathBlock key={`m${blocks.length}`} tex={parts.join(' ').trim()} />)
      }
      continue
    }

    // LaTeX 定界符公式块 \[…\]（部分模型用这套写法）
    if (t.startsWith('\\[')) {
      flushPara()
      const oneLine = /\\\]/.test(t.slice(2))
      if (oneLine) {
        blocks.push(<MathBlock key={`m${blocks.length}`} tex={t.slice(2).replace(/\\\]$/, '').trim()} />)
        li++
      } else {
        const parts: string[] = [t.slice(2)]
        li++
        while (li < lines.length && !lines[li].trim().endsWith('\\]')) {
          parts.push(lines[li])
          li++
        }
        if (li < lines.length) {
          parts.push(lines[li].trim().replace(/\\\]$/, ''))
          li++
        }
        blocks.push(<MathBlock key={`m${blocks.length}`} tex={parts.join(' ').trim()} />)
      }
      continue
    }

    // 列表
    if (LIST_RE.test(t)) {
      flushPara()
      const { nodes, end } = parseListBlock(lines, li)
      blocks.push(<div key={`l${blocks.length}`} className="md-list-wrap">{renderListLevel(nodes, `l${blocks.length}`, sources, onJump)}</div>)
      li = end
      continue
    }

    para.push(t)
    li++
  }
  flushPara()
  return blocks
}

// ---------- 纯文本 + 公式编译（不做 markdown 结构化） ----------
// 用于划词原文/用户引用等「原始文本」场景：只把 $…$ / $$…$$ / \(…\) / \[…\]
// 编译成 KaTeX，其余保持原样（换行保留），避免把原文里的 * - | 等误当排版符号

function mathInlineParts(line: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\$(?=\S)[^$\n]*\S\$)|(\\\(.+?\\\))/g
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index))
    out.push(<MathSpan key={`${keyBase}-m${k++}`} tex={m[1] ? m[1].slice(1, -1) : m[2].slice(2, -2)} />)
    last = m.index + m[0].length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

export function renderMathText(content: string): ReactNode {
  const nodes: ReactNode[] = []
  const blockRe = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  const pushText = (t: string): void => {
    t.split('\n').forEach((ln, i) => {
      if (i > 0) nodes.push(<br key={`br${k++}`} />)
      nodes.push(...mathInlineParts(ln, `mt${k}`))
    })
  }
  while ((m = blockRe.exec(content))) {
    if (m.index > last) pushText(content.slice(last, m.index))
    nodes.push(<MathBlock key={`mb${k++}`} tex={(m[1] ?? m[2]).trim()} />)
    last = m.index + m[0].length
  }
  if (last < content.length) pushText(content.slice(last))
  return nodes
}
