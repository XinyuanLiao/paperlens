// 三层结构化分块（v5）：
// 第一层按章节（liteparse 标题），第二层章节内按段落聚合，第三层超长段落按句切分并带论点句前缀。
// 目标块 ~1024 token（CJK≈1 token/字、拉丁≈4 字符/token 估算；512 不足以覆盖完整段落，2026-09-24 调大），
// 相邻块 128 token 重叠。重叠与论点前缀只进「嵌入文本」：BM25 与引用跳转用的库内 text 保持干净原文，
// 避免重叠内容稀释 trigram 命中、也让 snippet 精确对应真实段落。

export interface MdBlock {
  text: string
  sectionNo: string
  sectionTitle: string
  kind: 'body' | 'abstract' | 'caption'
  // liteparse 逐页输出，页码天然已知（引用跳转依赖）
  page: number
}

// ---------- liteparse 逐页 markdown → 结构块 ----------

// 尾部章节（参考文献/致谢/作者简介）：块直接丢弃，不进索引
// 必须整行就是尾部章节名（允许章节编号前缀与收尾标点）。以前是前缀匹配：
// 「Reference Signal Generation」「Reference Frame Oriented Control」这类正经小节
// 会被当成参考文献，整节内容从索引里消失
const BACK_MATTER_HEADING =
  /^(?:(?:[A-Z]?\.?\s*)?\d+(?:\.\d+)*\.?\s+)?(?:references?(?:\s+cited)?|bibliography|acknowledg(?:e)?ments?|author\s+biographies?|biograph(?:y|ies)|参考文献|致\s*谢|作者简介)\s*[.:：]?$/i
const APPENDIX_HEADING = /^(?:appendix|appendices|supplementary|附\s*录)/i
const ABSTRACT_HEADING = /^(?:abstract|summary|摘\s*要)\b/i
const CAPTION_RE = /^(?:figure|fig\.|table|图|表)\s*\d+/i
// 章节编号：阿拉伯（3.2 / 3.2.1）、罗马（III.）、中文（第三章）
const NUM_ARABIC = /^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/
const NUM_ROMAN = /^(ix|iv|v?i{1,3})\.\s+(.*)$/i
const NUM_CN = /^第([一二三四五六七八九十百\d]+)章\s*(.*)$/
// 字母编号的小节（IEEE 惯例：「A. Reference Frame Oriented Control」）：挂在当前数字章节之下，记作 3-A
const NUM_ALPHA = /^([A-Z])\.\s+(.+)$/
// 把 liteparse 的逐页 markdown 解析为带章节元数据+页码的顺序块。
// 章节状态跨页延续（同章多页不重置），页边界 flush（跨页段落自然断开，不丢内容）
export function parseMdBlockPages(pagesMd: Array<{ page: number; md: string }>): MdBlock[] {
  // liteparse 偶尔把整段摘要黏在标题行里（## Abstract-DC-link capacitors are ...），
  // 截断存储防止伪标题污染后续所有块的章节标注
  const capTitle = (t: string): string => (t.length > 120 ? `${t.slice(0, 120)}…` : t)
  const blocks: MdBlock[] = []
  let sectionNo = ''
  let sectionTitle = ''
  // 当前所在的顶级数字章节（字母小节要挂在它下面）
  let topNo = ''
  let kind: MdBlock['kind'] = 'body'
  let skipping = false
  let inFront = true // 首个标题之前的内容（题名/作者/关键词）整体视为摘要区
  let buf: string[] = []
  let fenceBuf: string[] | null = null // 公式/代码围栏：整块保留原始换行
  let curPage = pagesMd[0]?.page ?? 0

  const flush = (): void => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim()
    buf = []
    if (!text || skipping) return
    blocks.push({
      text,
      sectionNo,
      sectionTitle,
      kind: CAPTION_RE.test(text) && kind === 'body' ? 'caption' : kind,
      page: curPage
    })
  }

  for (const { page, md } of pagesMd) {
    // 页码先更新再解析：块入栈时拿到的是自己所在页（晚更新会让第二页起整体差一）
    flush() // 上一页残尾按上一页结算
    curPage = page
    for (const rawLine of md.split('\n')) {
      const line = rawLine.trimEnd()
      if (/^(```|~~~)/.test(line.trim())) {
        if (fenceBuf) {
          fenceBuf.push(line.trim())
          const text = fenceBuf.join('\n').trim()
          if (text && !skipping) {
            blocks.push({ text, sectionNo, sectionTitle, kind: kind === 'abstract' ? 'abstract' : 'body', page })
          }
          fenceBuf = null
        } else {
          flush()
          fenceBuf = [line.trim()]
        }
        continue
      }
      if (fenceBuf) {
        fenceBuf.push(line)
        continue
      }
      const hm = line.match(/^(#{1,6})\s+(.*)$/)
      if (hm) {
        flush()
        const title = hm[2].replace(/[*_`#]/g, '').trim()
        if (BACK_MATTER_HEADING.test(title)) {
          skipping = true
          continue
        }
        if (APPENDIX_HEADING.test(title)) {
          skipping = false
          sectionNo = 'Appendix'
          sectionTitle = title
          kind = 'body'
          inFront = false
          continue
        }
        skipping = false
        inFront = false
        const am = title.match(NUM_ARABIC)
        const rm = title.match(NUM_ROMAN)
        const cm = title.match(NUM_CN)
        const lm = title.match(NUM_ALPHA)
        if (am) {
          sectionNo = am[1]
          sectionTitle = capTitle(am[2].trim())
          topNo = am[1].split('.')[0]
        } else if (rm) {
          sectionNo = rm[1].toUpperCase()
          sectionTitle = capTitle(rm[2].trim())
          topNo = ''
        } else if (cm) {
          sectionNo = cm[1]
          sectionTitle = capTitle(cm[2].trim() || `第${cm[1]}章`)
          topNo = ''
        } else if (lm) {
          sectionNo = topNo ? `${topNo}-${lm[1]}` : lm[1]
          sectionTitle = capTitle(lm[2].trim())
        } else {
          sectionNo = ''
          sectionTitle = capTitle(title)
          topNo = ''
        }
        kind = ABSTRACT_HEADING.test(title) ? 'abstract' : 'body'
        continue
      }
      if (!line.trim()) {
        flush()
        continue
      }
      // 图片/纯链接行没有检索价值，直接跳过
      if (/^!\[[^\]]*\]\([^)]*\)$/.test(line.trim())) continue
      if (inFront) kind = 'abstract'
      buf.push(line.trim())
    }
    // 页边界 flush：跨页段落断开属正常（下一页重新聚合成自己的块）
    flush()
    curPage = page
  }
  flush()
  return blocks.filter((b) => b.text.length > 8)
}

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
      // 过短的落单段落并进上一个块；前面没有可并的块就自成一块。
      // 以前直接丢弃——跨页段落的残尾若恰好紧跟在标题前，那一两句就永远检索不到了
      const last = chunks[chunks.length - 1]
      if (last) {
        last.text += `\n${text}`
        last.tokens += tokens
        last.units.push(...unitsKept)
      } else {
        chunks.push({ ...meta, units: unitsKept, text, tokens })
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
export function chunkMdBlocks(blocks: MdBlock[]): ChunkJob[] {
  const raw: RawChunk[] = []
  let group: Unit[] = []
  let groupMeta: SectionMeta | null = null
  const flushGroup = (): void => {
    if (groupMeta && group.length) raw.push(...aggregate(group, groupMeta))
    group = []
    groupMeta = null
  }
  for (const block of blocks) {
    const page = block.page
    const meta: SectionMeta = { sectionNo: block.sectionNo, sectionTitle: block.sectionTitle, kind: block.kind, page }
    if (block.kind === 'caption') {
      // 图表题注独立小块：常被「哪个图/表」类问题命中，不与正文混
      const tokens = estimateTokens(block.text)
      if (tokens >= 10) raw.push({ ...meta, units: [{ text: block.text, tokens }], text: block.text, tokens })
      continue
    }
    const sameGroup =
      groupMeta !== null &&
      groupMeta.page === meta.page &&
      groupMeta.sectionNo === meta.sectionNo &&
      groupMeta.sectionTitle === meta.sectionTitle &&
      groupMeta.kind === meta.kind
    // 页码必须参与分组：正文无 # 标题的论文（liteparse 对双栏排版常如此）整篇共享同一
    // 章节元数据，不按页断组的话所有块会被并进一个组、页码全部记到组里最后一个块的页
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

// ---------- 整篇文本的尾部裁剪（pdfjs 抽取路径与整篇问答模式共用）----------
//
// 参考文献/致谢/作者简介等尾部章节：这些页是引文清单与作者信息，进入 RAG 会污染检索片段
//（引用跳转会落在奇怪的页面上），从命中处起裁掉。保持数组长度不变，页码 / 总页数语义不受影响。

// 参考文献/致谢/作者简介等尾部章节标题：这些页是引文清单与作者信息，
// 进入 RAG 会污染检索片段（且引用跳转会落在奇怪的页面），从索引起点剔除
const BACK_MATTER_RE = /^(?:(?:\d+(?:\.\d+)*|[IVXLC]+)\.?\s+)?(?:references(?:\s+cited)?|bibliography|acknowledg?ments?|biograph(?:y|ies)|author biographies?|参考文献|致谢|作者简介)\s*$/i
// 「参考文献」这一类：出现即尾部，不看位置
const REFS_RE = /^(?:(?:\d+(?:\.\d+)*|[IVXLC]+)\.?\s+)?(?:references(?:\s+cited)?|bibliography|参考文献)\s*$/i

// 其余尾部章节（致谢、作者简介）不能只凭标题就裁。IEEE 系期刊常把致谢放在首页脚注里，
// 双栏版面下它排在左栏末尾——照它裁，右栏和后面所有页都没了，论文只剩首页左栏。
// 三条里满足一条才认：① 在末尾几页；② 到下一个「参考文献」标题前的内容很少（真正的致谢都很短）；
// ③ 整篇只有一页
const TAIL_ACK_MAX_CHARS = 1500
const inTailPages = (n: number, p: number): boolean => n <= 1 || p >= n - Math.max(1, Math.ceil(n * 0.2))
function shortUntilRefs(pages: string[], p0: number, i0: number): boolean {
  let chars = 0
  for (let p = p0; p < pages.length; p++) {
    const lines = pages[p].split('\n')
    for (let i = p === p0 ? i0 + 1 : 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (REFS_RE.test(t)) return true // 到参考文献为止都算致谢的内容
      chars += t.length
      if (chars > TAIL_ACK_MAX_CHARS) return false
    }
  }
  return true
}

// 尾部章节裁剪：命中标题起（同页只留标题前的正文，后续页清空）；
// 保持数组长度不变，页码/总页数语义不受影响
export function stripBackMatter(pages: string[]): string[] {
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p].split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.length > 48 || !BACK_MATTER_RE.test(t)) continue
      if (!REFS_RE.test(t) && !inTailPages(pages.length, p) && !shortUntilRefs(pages, p, i)) continue
      const out = pages.slice()
      out[p] = lines.slice(0, i).join('\n').trim()
      for (let q = p + 1; q < out.length; q++) out[q] = ''
      return out
    }
  }
  return pages
}
