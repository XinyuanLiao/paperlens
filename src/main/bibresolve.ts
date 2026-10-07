// 单篇论文的 BibTeX 联网矫正（依赖 refmeta + bibtext，均不依赖 electron，可独立联网测试）。
//
// 置信度分层：
//   official — lookupBibMeta 标题命中（dice≥0.6 + 年份差≤2）且有 DOI → doi.org 内容协商取
//              官方 BibTeX → 解析回读、标题/年份二次比对，全过才采用；
//   web      — 命中但无 DOI（ICLR/arXiv 类）或官方获取失败，用检索元数据按条目类型拼装；
//   local    — 未命中/离线，用库内字段拼装并挂 unverified 警告。
// 任何网络失败都安静降级，绝不 throw。

import { lookupBibMeta, diceBigram, UA } from './refmeta'
import { parseBibtexEntry, makeCiteKey, latexEscape, foldUnicode, type ParsedEntry } from './bibtext'

export type BibSource = 'official' | 'web' | 'local'

export interface PaperMeta {
  title: string
  authors: string
  year: number | null
  venue: string
}

// 与 enrich.ts 一致的严格门槛：导错条目比缺条目更糟
const DICE_MIN = 0.6
const YEAR_GAP_MAX = 2
// 官方条目回读比对门槛略宽：DOI 已是精确标识，只防内容协商跑到错误条目/代理页
const DICE_MIN_OFFICIAL = 0.5

// 官方 BibTeX 里值得保留的字段白名单（month/issn/__内部标记__ 一律丢弃）
const KEEP_FIELDS = new Set([
  'author', 'editor', 'title', 'journal', 'booktitle', 'year', 'volume', 'number',
  'pages', 'chapter', 'edition', 'series', 'publisher', 'address', 'institution',
  'school', 'doi', 'url', 'note'
])

// CrossRef 条目类型 → BibTeX 类型；S2 无类型时按 venue 关键词猜会议，猜不出按期刊/杂项
function entryType(kind: string, venue: string): string {
  switch (kind) {
    case 'journal-article': return 'article'
    case 'proceedings-article': return 'inproceedings'
    case 'book-chapter': return 'inbook'
    case 'book': return 'book'
    case 'report': return 'techreport'
    case 'report-component': return 'techreport'
    default:
      if (/conference|symposium|workshop|proceedings|meeting/i.test(venue)) return 'inproceedings'
      return venue ? 'article' : 'misc'
  }
}

// doi.org 内容协商直取出版方登记的官方 BibTeX（302 到 data.crossref.org，fetch 自动跟随）
export async function fetchOfficialBibtex(doi: string): Promise<ParsedEntry | null> {
  const d = doi.trim()
  if (!d) return null
  try {
    const res = await fetch(`https://doi.org/${encodeURIComponent(d)}`, {
      headers: { Accept: 'application/x-bibtex; charset=utf-8', 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null
    const text = await res.text()
    if (!text.trimStart().startsWith('@')) return null
    // 官方内容也必须解析得回来（截断/代理页直接判失败）
    return parseBibtexEntry(text)
  } catch {
    return null
  }
}

// 拼装字段：库内/检索原始文本要转义 + 折叠 Unicode（官方条目已是 LaTeX 形态，不再过这层）
function esc(s: string): string {
  return latexEscape(foldUnicode(s.replace(/\s+/g, ' ').trim()))
}

// 作者串（"A B, C D"）转 BibTeX " and " 连接
function toBibAuthors(authors: string): string {
  return authors
    .split(/\s*,\s*/)
    .map((a) => a.trim())
    .filter(Boolean)
    .join(' and ')
}

// web/local 层的条目拼装：类型启发 + 必填字段缺失挂警告
function buildAssembledEntry(
  p: PaperMeta,
  meta: { authors: string; year: number | null; venue: string; doi: string; landing: string; kind: string } | null
): { entry: ParsedEntry; source: BibSource; warnings: string[] } {
  const authors = meta?.authors || p.authors
  const year = meta?.year ?? p.year
  const venue = meta?.venue || p.venue
  const doi = meta?.doi || ''
  const warnings: string[] = []
  const fields: Record<string, string> = {}
  if (authors) fields.author = esc(toBibAuthors(authors))
  else warnings.push('no-authors')
  fields.title = esc(p.title || 'Untitled')
  const type = entryType(meta?.kind ?? '', venue)
  if (venue) fields[type === 'inproceedings' ? 'booktitle' : 'journal'] = esc(venue)
  else warnings.push('no-venue')
  if (year != null) fields.year = String(year)
  else warnings.push('no-year')
  if (doi) fields.doi = doi
  else if (meta?.landing) fields.url = meta.landing
  return {
    entry: { type, key: makeCiteKey(authors, year, p.title), fields },
    source: meta ? 'web' : 'local',
    warnings: meta ? warnings : [...warnings, 'unverified']
  }
}

// 单篇解析（矫正链主路径）
export async function resolvePaperEntry(p: PaperMeta & { slug?: string }): Promise<{
  entry: ParsedEntry
  source: BibSource
  warnings: string[]
}> {
  const title = p.title.trim()
  if (!title) return buildAssembledEntry(p, null)
  try {
    const meta = await lookupBibMeta(title)
    // 严格门槛：标题 dice 与年份差（与 enrich.ts 一致），不过线视为未命中
    if (!meta || diceBigram(meta.title.toLowerCase(), title.toLowerCase()) < DICE_MIN) {
      return buildAssembledEntry(p, null)
    }
    if (p.year != null && meta.year != null && Math.abs(p.year - meta.year) > YEAR_GAP_MAX) {
      return buildAssembledEntry(p, null)
    }
    // 命中且有 DOI：内容协商取官方 BibTeX，回读后二次比对
    if (meta.doi) {
      const official = await fetchOfficialBibtex(meta.doi)
      if (official) {
        // 官方字段已是 LaTeX 形态，不做 latexEscape（会破坏 {IGBT} 类保护括号），
        // 但要折叠残留 Unicode（CrossRef 常给 en-dash，pdfLaTeX 编不过）
        const fields: Record<string, string> = {}
        for (const [k, v] of Object.entries(official.fields)) if (KEEP_FIELDS.has(k)) fields[k] = foldUnicode(v)
        const offTitle = (fields.title ?? '').replace(/[{}]/g, '').toLowerCase()
        const offYear = parseInt(fields.year ?? '', 10)
        const titleOk = !!offTitle && diceBigram(offTitle, title.toLowerCase()) >= DICE_MIN_OFFICIAL
        const yearOk = !(p.year != null && Number.isFinite(offYear) && Math.abs(p.year - offYear) > YEAR_GAP_MAX)
        if (titleOk && yearOk && fields.title) {
          return {
            entry: { type: official.type, key: makeCiteKey(fields.author ?? meta.authors, meta.year ?? p.year, title), fields },
            source: 'official',
            warnings: []
          }
        }
      }
    }
    // 无 DOI / 官方获取或比对失败 → 检索元数据拼装（标题与年份已过严格门槛）
    return buildAssembledEntry(p, {
      authors: meta.authors,
      year: meta.year,
      venue: meta.venue,
      doi: meta.doi,
      landing: meta.landing,
      kind: meta.kind
    })
  } catch {
    return buildAssembledEntry(p, null)
  }
}
