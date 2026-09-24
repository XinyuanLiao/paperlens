import type { MdBlock } from './marker'
import { alignBlocksToPages } from './marker'

// 三层结构化分块（v5）：
// 第一层按章节（marker 标题），第二层章节内按段落聚合，第三层超长段落按句切分并带论点句前缀。
// 目标块 ~1024 token（CJK≈1 token/字、拉丁≈4 字符/token 估算；512 不足以覆盖完整段落，2026-09-24 调大），
// 相邻块 128 token 重叠。重叠与论点前缀只进「嵌入文本」：BM25 与引用跳转用的库内 text 保持干净原文，
// 避免重叠内容稀释 trigram 命中、也让 snippet 精确对应真实段落。

export interface ChunkJob {
  page: number
  ord: number
  // 库内存储 + FTS + snippet 用的原文
  text: string
  // 嵌入用的文本（论点句/重叠只在这里出现，buildIndex 再叠加分类前缀）
  embedText: string
  sectionNo: string
  sectionTitle: string
  kind: 'body' | 'abstract' | 'caption'
}

const TARGET = 1024 // 聚合目标（token）：覆盖 1-2 个完整段落
const HARD = 1400 // 超过即触发句级切分（token）
const MIN_CHUNK = 40 // 正文块保底长度（token）
const OVERLAP_TOK = 128 // 相邻块重叠（token）

// token 估算：CJK 每字符≈1，其余≈4 字符/token
export function estimateTokens(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

// 句子切分：按中英文句读断开，结束符归属前句
const SENT_RE = /[^.。;；!！?？\n]+[.。;；!！?？]*/g
export function splitSentences(text: string): string[] {
  return (text.match(SENT_RE) ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
}

// 取文本尾部 ~tok 个 token（在句边界对齐，找不到句界就按字符截）
function tailTokens(text: string, tok: number): string {
  const chars = tok * 3 // 混合文本的粗换算，尾部截取宁可短一点
  const head = text.length > chars * 2 ? text.slice(text.length - chars * 2) : text
  const sents = splitSentences(head)
  const out: string[] = []
  let used = 0
  for (let i = sents.length - 1; i >= 0; i--) {
    const t = estimateTokens(sents[i])
    if (used + t > tok && out.length) break
    out.unshift(sents[i])
    used += t
    if (used >= tok) break
  }
  return out.join(' ') || text.slice(-chars)
}

// 段落单元：超长段落切出的子块可带论点句（topic）与同段上一子块尾部（subOverlap）
interface Unit {
  text: string
  tokens: number
  topic?: string
  subOverlap?: string
}

interface SectionMeta {
  sectionNo: string
  sectionTitle: string
  kind: ChunkJob['kind']
  page: number
}

interface RawChunk extends SectionMeta {
  units: Unit[]
  text: string
  tokens: number
}

// 第二层：同章节的段落单元聚合到 ~TARGET token（段落是完整论证单元，不拆散）
function aggregate(units: Unit[], meta: SectionMeta): RawChunk[] {
  const chunks: RawChunk[] = []
  let buf: Unit[] = []
  let used = 0
  const flush = (): void => {
    if (!buf.length) return
    const text = buf.map((u) => u.text).join('\n')
    const tokens = used
    const unitsKept = buf
    buf = []
    used = 0
    if (tokens < MIN_CHUNK) {
      // 过短的落单段落并进上一个块（首块前出现则丢弃）
      const last = chunks[chunks.length - 1]
      if (last) {
        last.text += `\n${text}`
        last.tokens += tokens
        last.units.push(...unitsKept)
      }
      return
    }
    chunks.push({ ...meta, units: unitsKept, text, tokens })
  }
  for (const u of units) {
    if (used > 0 && used + u.tokens > TARGET) flush()
    buf.push(u)
    used += u.tokens
  }
  flush()
  return chunks
}

// 第三层：超长段落句级切分为 ≤TARGET 的子块；非首子块带论点句与上一子块尾部
function splitOversized(text: string, topic: string): Unit[] {
  const sents = splitSentences(text)
  const out: Unit[] = []
  let buf: string[] = []
  let used = 0
  let prevTail = ''
  const push = (own: string, tokens: number): void => {
    const first = out.length === 0
    out.push({
      text: own,
      tokens,
      ...(first ? {} : { topic }),
      ...(first || !prevTail ? {} : { subOverlap: prevTail })
    })
    prevTail = tailTokens(own, OVERLAP_TOK)
  }
  for (const s of sents) {
    const t = estimateTokens(s)
    if (used > 0 && used + t > TARGET) {
      push(buf.join(' '), used)
      buf = []
      used = 0
    }
    buf.push(s)
    used += t
  }
  if (buf.length) {
    const own = buf.join(' ')
    const tokens = used
    if (tokens < MIN_CHUNK && out.length) {
      out[out.length - 1].text += ` ${own}`
      out[out.length - 1].tokens += tokens
    } else push(own, tokens)
  }
  return out
}

// 由单元序列生成 embedText：前块重叠 + 子块论点/同段重叠 + 原文
function buildEmbedText(units: Unit[], prevChunk: RawChunk | null): string {
  const parts: string[] = []
  if (prevChunk) parts.push(tailTokens(prevChunk.text, OVERLAP_TOK))
  for (const u of units) {
    if (u.subOverlap) parts.push(u.subOverlap)
    if (u.topic) parts.push(`（本段论点）${u.topic}`)
    parts.push(u.text)
  }
  return parts.join('\n')
}

function toJobs(raw: RawChunk[]): ChunkJob[] {
  const out: ChunkJob[] = []
  raw.forEach((c, i) => {
    if (!c.text.trim()) return
    out.push({
      page: c.page,
      ord: out.length,
      text: c.text,
      embedText: buildEmbedText(c.units, i > 0 ? raw[i - 1] : null),
      sectionNo: c.sectionNo,
      sectionTitle: c.sectionTitle,
      kind: c.kind
    })
  })
  return out
}

// marker 路径：markdown 结构块 → 三层分块；caption 独立小块，参考文献已在解析层剔除
export function chunkMdBlocks(blocks: MdBlock[], pages: string[]): ChunkJob[] {
  const aligned = alignBlocksToPages(blocks, pages)
  const raw: RawChunk[] = []
  let group: Unit[] = []
  let groupMeta: SectionMeta | null = null
  const flushGroup = (): void => {
    if (groupMeta && group.length) raw.push(...aggregate(group, groupMeta))
    group = []
    groupMeta = null
  }
  for (const { block, page } of aligned) {
    const meta: SectionMeta = { sectionNo: block.sectionNo, sectionTitle: block.sectionTitle, kind: block.kind, page }
    if (block.kind === 'caption') {
      // 图表题注独立小块：常被「哪个图/表」类问题命中，不与正文混
      const tokens = estimateTokens(block.text)
      if (tokens >= 10) raw.push({ ...meta, units: [{ text: block.text, tokens }], text: block.text, tokens })
      continue
    }
    const sameGroup =
      groupMeta !== null &&
      groupMeta.sectionNo === meta.sectionNo &&
      groupMeta.sectionTitle === meta.sectionTitle &&
      groupMeta.kind === meta.kind
    if (!sameGroup) flushGroup()
    const tokens = estimateTokens(block.text)
    if (tokens > HARD) {
      // 超长段落：先冲掉当前组，子块独立聚合（保证论点前缀语义不被合并稀释）
      flushGroup()
      const topic = splitSentences(block.text)[0] ?? block.text.slice(0, 120)
      raw.push(...aggregate(splitOversized(block.text, topic), meta))
      continue
    }
    groupMeta = meta
    group.push({ text: block.text, tokens })
  }
  flushGroup()
  return toJobs(raw)
}

// 内置回退路径：逐页伪章节，行为单元，同样按 256-512 tok 聚合（无章节元数据）
export function chunkPages(pages: string[]): ChunkJob[] {
  const raw: RawChunk[] = []
  for (let p = 0; p < pages.length; p++) {
    const meta: SectionMeta = { sectionNo: '', sectionTitle: '', kind: 'body', page: p + 1 }
    const units: Unit[] = []
    for (const line of pages[p].split('\n')) {
      const t = line.trim()
      if (!t) continue
      const tokens = estimateTokens(t)
      if (tokens > HARD) {
        const topic = splitSentences(t)[0] ?? t.slice(0, 120)
        units.push(...splitOversized(t, topic))
      } else if (tokens >= 8) units.push({ text: t, tokens })
    }
    raw.push(...aggregate(units, meta))
  }
  return toJobs(raw)
}
