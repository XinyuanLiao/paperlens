// 参考文献元数据补全 + OA PDF 下载（主进程纯 Node，不依赖 electron）
// 主路 CrossRef 按参考文献原文做书目检索，拿不到（ICLR/OpenReview 类无 DOI 收录）再退 Semantic Scholar；
// 有 DOI 时并行问 Unpaywall 与 S2 收集开放获取 PDF 直链，供引用面板一键下载原文。

import fs from 'node:fs'

export interface RefMeta {
  title: string
  authors: string
  year: number | null
  venue: string
  doi: string
  citedBy: number | null
  pdfUrls: string[]
  landing: string
  source: 'crossref' | 's2' | 'none'
}

// 统一 UA：CrossRef/Unpaywall 要求带联系方式的山羊头 UA，纯匿名请求会被限流
const UA = 'PaperLens/0.2 (mailto:planck@users.noreply.github.com)'

// ---------- 内部辅助 ----------

// 统一 fetch+json：学术 API 波动大（429/超时/网断），任何失败一律吞掉返回 null，
// 让上层走兜底而不是把整条引用查询打断
async function jget(url: string, timeoutMs: number): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// 字符 bigram 集合的 Dice 系数：宽过 S2 兜底检索的标题相似度门槛用，
// 任一串过短（<2）没有 bigram 可比，直接 0
function diceBigram(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0
  const ga = new Set<string>()
  for (let i = 0; i < a.length - 1; i++) ga.add(a.slice(i, i + 2))
  const gb = new Set<string>()
  for (let i = 0; i < b.length - 1; i++) gb.add(b.slice(i, i + 2))
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit++
  return (2 * hit) / (ga.size + gb.size)
}

// PDF 候选清洗：只留 http(s)、按小写去重；
// 排序权重 Unpaywall（编辑校验过的 OA 库）> 直链 .pdf > arxiv > 其余，
// Array#sort 在 ES2019+ 稳定，同权重保持插入序；最多 5 个防止列表爆炸
function cleanPdfUrls(cands: Array<{ url: string; fromUnpaywall?: boolean }>): string[] {
  const seen = new Set<string>()
  const list: Array<{ url: string; w: number }> = []
  for (const c of cands) {
    const url = c.url.trim()
    if (!/^https?:\/\//i.test(url)) continue
    const lower = url.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    const w = c.fromUnpaywall ? 0 : lower.endsWith('.pdf') ? 1 : lower.includes('arxiv') ? 2 : 3
    list.push({ url, w })
  }
  return list
    .sort((a, b) => a.w - b.w)
    .slice(0, 5)
    .map((x) => x.url)
}

// CrossRef 著者条目可能只有 family（机构化条目）或只有 given，拼完去空
function crossrefAuthors(author: any): string {
  if (!Array.isArray(author)) return ''
  return author
    .map((a: any) => `${a?.given ?? ''} ${a?.family ?? ''}`.trim())
    .filter(Boolean)
    .join(', ')
}

// ---------- 各数据源 ----------

async function crossrefLookup(q: string): Promise<RefMeta | null> {
  const url =
    'https://api.crossref.org/works?query.bibliographic=' +
    encodeURIComponent(q) +
    '&rows=4&select=title,author,issued,container-title,DOI,is-referenced-by-count'
  const data = await jget(url, 8_000)
  const items = data?.message?.items
  if (!Array.isArray(items)) return null
  // 不取第一个有 title 的：书目检索常返回题名相近的错误条目（书章节/综述），
  // 在少量候选里按「标题 vs 原文」bigram-Dice 择优，低于门槛视为未命中（转 S2 兜底）
  const ql = q.toLowerCase()
  let best: { meta: RefMeta; dice: number } | null = null
  for (const it of items) {
    // title 是数组且可能含 CrossRef 内部标注标签（如 <jats:title>），取首个去标签
    const rawTitle = Array.isArray(it?.title) && typeof it.title[0] === 'string' ? it.title[0] : ''
    const title = rawTitle.replace(/<[^>]+>/g, '').trim()
    if (!title) continue
    const doi = typeof it?.DOI === 'string' ? it.DOI : ''
    const yearNum = it?.issued?.['date-parts']?.[0]?.[0]
    const meta: RefMeta = {
      title,
      authors: crossrefAuthors(it?.author),
      year: typeof yearNum === 'number' ? yearNum : null,
      venue: typeof it?.['container-title']?.[0] === 'string' ? it['container-title'][0] : '',
      doi,
      citedBy: typeof it?.['is-referenced-by-count'] === 'number' ? it['is-referenced-by-count'] : null,
      pdfUrls: [],
      landing: doi ? `https://doi.org/${doi}` : '',
      source: 'crossref'
    }
    const dice = diceBigram(title.toLowerCase(), ql)
    if (!best || dice > best.dice) best = { meta, dice }
  }
  return best && best.dice > 0.12 ? best.meta : null
}

// Unpaywall 的 url_for_pdf 都是经过核验的 OA 副本，best_oa_location 是官方推荐位，排最前
async function unpaywallCandidates(doi: string): Promise<Array<{ url: string; fromUnpaywall?: boolean }>> {
  const data = await jget(`https://api.unpaywall.org/v2/${doi}?email=planck@users.noreply.github.com`, 8_000)
  if (!data || typeof data !== 'object') return []
  const out: Array<{ url: string; fromUnpaywall: boolean }> = []
  const best = data?.best_oa_location?.url_for_pdf
  if (typeof best === 'string' && best.trim()) out.push({ url: best.trim(), fromUnpaywall: true })
  const locs = Array.isArray(data?.oa_locations) ? data.oa_locations : []
  for (const l of locs) {
    if (typeof l?.url_for_pdf === 'string' && l.url_for_pdf.trim()) out.push({ url: l.url_for_pdf.trim(), fromUnpaywall: true })
  }
  return out
}

// S2 按 DOI 补 PDF 与被引：openAccessPdf.url 可能是落地页，
// 只收 .pdf 直链或 arxiv（arxiv 的 /pdf/<id> 无后缀但确为 PDF）
async function s2ByDoi(doi: string): Promise<{ pdfUrl: string; citationCount: number | null } | null> {
  const data = await jget(
    `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=openAccessPdf,citationCount`,
    8_000
  )
  if (!data || typeof data !== 'object') return null
  const pdf = typeof data?.openAccessPdf?.url === 'string' ? data.openAccessPdf.url : ''
  const lower = pdf.toLowerCase()
  const pdfUrl = pdf && (lower.endsWith('.pdf') || lower.includes('arxiv')) ? pdf : ''
  return {
    pdfUrl,
    citationCount: typeof data?.citationCount === 'number' ? data.citationCount : null
  }
}

// S2 兜底检索：CrossRef 没收录的会议文（ICLR/NeurIPS 等）从这里拿；
// 检索是模糊的，必须用 bigram-Dice 过滤掉风马牛不相及的命中
async function s2Search(q: string): Promise<RefMeta | null> {
  const url =
    'https://api.semanticscholar.org/graph/v1/paper/search?query=' +
    encodeURIComponent(q.slice(0, 300)) +
    '&fields=title,authors,year,venue,externalIds,openAccessPdf,citationCount&limit=5'
  const data = await jget(url, 8_000)
  const items = Array.isArray(data?.data) ? data.data : []
  const ql = q.toLowerCase()
  for (const it of items) {
    const title = typeof it?.title === 'string' ? it.title : ''
    if (!title || diceBigram(title.toLowerCase(), ql) <= 0.15) continue
    const doi = typeof it?.externalIds?.DOI === 'string' ? it.externalIds.DOI : ''
    const pdf = typeof it?.openAccessPdf?.url === 'string' ? it.openAccessPdf.url : ''
    const lower = pdf.toLowerCase()
    const pdfUrl = pdf && (lower.endsWith('.pdf') || lower.includes('arxiv')) ? pdf : ''
    return {
      title,
      authors: Array.isArray(it?.authors)
        ? it.authors.map((a: any) => (typeof a?.name === 'string' ? a.name : '')).filter(Boolean).join(', ')
        : '',
      year: typeof it?.year === 'number' ? it.year : null,
      venue: typeof it?.venue === 'string' ? it.venue : '',
      doi,
      citedBy: typeof it?.citationCount === 'number' ? it.citationCount : null,
      pdfUrls: cleanPdfUrls(pdfUrl ? [{ url: pdfUrl }] : []),
      landing: doi ? `https://doi.org/${doi}` : '',
      source: 's2'
    }
  }
  return null
}

// ---------- 对外接口 ----------

// 输入为一条参考文献条目原文（如 "[3] J. Smith, Power electronics, IEEE Trans., 2019"）。
// 任何失败（无网/超时/无结果）返回 null，绝不 throw。
export async function lookupRefMeta(raw: string): Promise<RefMeta | null> {
  // 清洗：压缩空白、截 500 字符（API 对超长 query 会拒绝或稀释匹配）、去行首编号
  const q = raw
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 500)
    .replace(/^(?:\[\d+\]|\(\d+\)|\d+\.)\s*/, '')
    .trim()
  if (!q) return null

  const cr = await crossrefLookup(q)
  if (cr) {
    if (cr.doi) {
      // 两源互不依赖，并行跑省一半延迟；各自内部已吞错
      const [uw, s2] = await Promise.all([unpaywallCandidates(cr.doi), s2ByDoi(cr.doi)])
      const cands = [...uw]
      if (s2?.pdfUrl) cands.push({ url: s2.pdfUrl })
      cr.pdfUrls = cleanPdfUrls(cands)
      // CrossRef 没给被引（理论上少见）时用 S2 补
      if (cr.citedBy == null && s2?.citationCount != null) cr.citedBy = s2.citationCount
    }
    return cr
  }

  return s2Search(q)
}

// 依次尝试 urls，把第一个真正可下载的 PDF 写入 dest，成功 { ok: true }。
// 全部失败返回 { ok: false, error: 中文友好错误信息 }，绝不 throw。
export async function downloadRefPdf(urls: string[], dest: string): Promise<{ ok: boolean; error?: string }> {
  let lastNetErr = ''
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/pdf,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000)
      })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      // 150MB 上限先挡住异常大文件，避免把内存当磁盘使
      if (buf.length > 150 * 1024 * 1024) continue
      // 部分站点对直链请求回 200 的 HTML 落地页；%PDF 头可能前带垃圾字节，在头部 1KB 内找
      if (!buf.subarray(0, 1024).includes('%PDF')) continue
      fs.writeFileSync(dest, buf)
      return { ok: true }
    } catch (e) {
      // 单个 url 的 DNS/超时异常不致命，记下原因继续下一个
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) lastNetErr = '请求超时'
      else if (e instanceof TypeError) lastNetErr = '网络错误'
    }
  }
  // 超时/网络错误另附简短原因，其余情况保持固定文案避免暴露技术细节
  const suffix = lastNetErr ? `：${lastNetErr}` : ''
  return { ok: false, error: `未能下载 PDF（链接可能不是开放获取直链）${suffix}` }
}
