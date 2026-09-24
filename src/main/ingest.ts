import fs from 'node:fs'
import path from 'node:path'
import { getDb, getSettings } from './db'
import { embed, embedModelId } from './embed'
import { runLiteparse } from './liteparse'
import { chunkMdBlocks, chunkPages, parseMdBlockPages, type ChunkJob } from './chunk'
import { rerankChunks, rerankEnabled, rerankDevice } from './rerank'
import type { PreparedQuery } from './query'

let running = false

export function isIndexRunning(): boolean {
  return running
}

// 分块算法版本：改动分块逻辑时递增，buildIndex 检测到旧版本索引会自动清空重建
// v3：裁参考文献 + 分类前缀嵌入；v4：结构化三层分块；v5：块目标 1024 token、重叠 128
const CHUNK_VERSION = 5
// 结构化解析引擎（liteparse 随应用内置，无 OCR；旧引擎值 'marker'/'builtin' 不一致即触发重建）
const PDF_ENGINE = 'liteparse'
// 精排候选数（固定）：GPU = 40；仅 CPU 轻量 = 24
const RERANK_CANDIDATES = 40
const LITE_CANDIDATES = 24

// 库是否需要（重新）索引：有待索引论文、分块算法/嵌入模型/解析引擎版本落后，或整篇级向量/标题索引缺失
export function indexNeedsRebuild(): boolean {
  const db = getDb()
  const pending = db.prepare('SELECT COUNT(*) AS n FROM papers WHERE indexed=0').get() as { n: number }
  if (pending.n > 0) return true
  const v = db.prepare("SELECT value FROM meta WHERE key='chunk_v'").get() as { value: string } | undefined
  if (!v || v.value !== String(CHUNK_VERSION)) return true
  // 嵌入模型 / 解析引擎切换同样使旧索引不可比（写在 buildIndex 里的清库条件要靠这里触发）
  const m = db.prepare("SELECT value FROM meta WHERE key='embed_model'").get() as { value: string } | undefined
  if (m?.value !== embedModelId()) return true
  const e = db.prepare("SELECT value FROM meta WHERE key='pdf_engine'").get() as { value: string } | undefined
  if (e?.value !== PDF_ENGINE) return true
  const noPvec = db.prepare('SELECT COUNT(*) AS n FROM papers WHERE pvec IS NULL').get() as { n: number }
  if (noPvec.n > 0) return true
  const noFts = db
    .prepare('SELECT COUNT(*) AS n FROM papers p LEFT JOIN papers_fts f ON f.rowid=p.id WHERE p.indexed=1 AND f.rowid IS NULL')
    .get() as { n: number }
  return noFts.n > 0
}

// v2 分块：按行（近似段落）聚合到 ~1200 字符，避免把句子/段落从中间截断，
// 嵌入向量与检索片段的语义边界都更干净；单行超长时才在句读处硬切
// （v4 起由 chunk.ts 的三层结构化分块取代，此函数仅保留给内置路径之外的临时抽取）

// 参考文献/致谢/作者简介等尾部章节标题：这些页是引文清单与作者信息，
// 进入 RAG 会污染检索片段（且引用跳转会落在奇怪的页面），从索引起点剔除
const BACK_MATTER_RE = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:references(?:\s+cited)?|bibliography|acknowledg?ments?|biograph(?:y|ies)|author biographies?|参考文献|致谢|作者简介)\s*$/i

// 尾部章节裁剪：命中标题起（同页只留标题前的正文，后续页清空）；
// 保持数组长度不变，页码/总页数语义不受影响
function stripBackMatter(pages: string[]): string[] {
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p].split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.length > 48 || !BACK_MATTER_RE.test(t)) continue
      const out = pages.slice()
      out[p] = lines.slice(0, i).join('\n').trim()
      for (let q = p + 1; q < out.length; q++) out[q] = ''
      return out
    }
  }
  return pages
}

export async function extractPages(pdfPath: string, maxPages = Infinity): Promise<string[]> {
  const { app } = await import('electron')
  const assetRoot = app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : app.getAppPath()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const doc = await (pdfjs as any).getDocument({
    data,
    useSystemFonts: false,
    standardFontDataUrl: path.join(assetRoot, 'node_modules/pdfjs-dist/standard_fonts/') + path.sep,
    cMapUrl: path.join(assetRoot, 'node_modules/pdfjs-dist/cmaps/') + path.sep,
    cMapPacked: true
  }).promise
  const pages: string[] = []
  for (let p = 1; p <= doc.numPages && p <= maxPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    // 按 y 坐标分行拼接，保留近似版面
    const items = tc.items as Array<{ str: string; transform: number[]; hasEOL?: boolean }>
    let line = ''
    let lastY: number | null = null
    const lines: string[] = []
    for (const it of items) {
      const y = Math.round(it.transform[5] ?? 0)
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        lines.push(line.trim())
        line = ''
      }
      line += it.str + ((it as any).hasEOL ? ' ' : '')
      lastY = y
    }
    if (line.trim()) lines.push(line.trim())
    pages.push(lines.join('\n'))
  }
  return stripBackMatter(pages)
}

// 带缓存的整文抽取（问答整篇模式用；按 mtime 失效）
const pageCache = new Map<string, { mtime: number; pages: string[] }>()
export async function extractPagesCached(pdfPath: string): Promise<string[]> {
  let mtime = 0
  try {
    mtime = fs.statSync(pdfPath).mtimeMs
  } catch {
    /* 读不到就没有缓存意义 */
  }
  const hit = pageCache.get(pdfPath)
  if (hit && hit.mtime === mtime) return hit.pages
  const pages = await extractPages(pdfPath)
  pageCache.set(pdfPath, { mtime, pages })
  return pages
}

export async function buildIndex(send: (ev: string, payload: unknown) => void): Promise<void> {
  if (running) return
  running = true
  // 本轮开始时的最大论文 id：结束后只对「运行期间新入库」的论文续跑，
  // 永久失败的旧论文（如 iCloud 未同步）不会造成无限重试循环
  let startMaxId = 0
  try {
    const db = getDb()
    const { dim } = await embed(['warmup'])
    const prevDim = db.prepare("SELECT value FROM meta WHERE key='embed_dim'").get() as { value: string } | undefined
    const prevV = db.prepare("SELECT value FROM meta WHERE key='chunk_v'").get() as { value: string } | undefined
    // PDF 解析引擎切换（旧 marker/builtin ↔ liteparse）：块内容与结构元数据不可比，同样清库重建
    const prevEngine = db.prepare("SELECT value FROM meta WHERE key='pdf_engine'").get() as { value: string } | undefined
    const prevModel = db.prepare("SELECT value FROM meta WHERE key='embed_model'").get() as { value: string } | undefined
    if (
      (prevDim && parseInt(prevDim.value) !== dim) ||
      prevV?.value !== String(CHUNK_VERSION) ||
      prevEngine?.value !== PDF_ENGINE ||
      prevModel?.value !== embedModelId()
    ) {
      // 嵌入维度变化/分块算法升级/引擎切换/嵌入模型更换：旧块不可比，清空全库重建（含整篇级向量/标题索引）
      db.exec('DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM papers_fts; UPDATE papers SET indexed=0, pvec=NULL')
    }
    db.prepare("INSERT INTO meta(key,value) VALUES('embed_dim',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(dim))
    db.prepare("INSERT INTO meta(key,value) VALUES('chunk_v',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(CHUNK_VERSION))
    db.prepare("INSERT INTO meta(key,value) VALUES('pdf_engine',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(PDF_ENGINE)
    db.prepare("INSERT INTO meta(key,value) VALUES('embed_model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(embedModelId())

    const todo = db.prepare('SELECT id, path, slug, title, authors, venue, category FROM papers WHERE indexed=0 ORDER BY id').all() as Array<{
      id: number
      path: string
      slug: string
      title: string
      authors: string
      venue: string
      category: string
    }>
    const setPvec = db.prepare('UPDATE papers SET pvec=? WHERE id=?')
    const setFts = db.prepare('INSERT OR REPLACE INTO papers_fts(rowid,title,authors,venue,slug) VALUES(?,?,?,?,?)')
    const paperVec = async (
      p: { id: number; slug: string; title: string; authors: string; venue: string; category: string },
      firstPage: string
    ): Promise<void> => {
      // 整篇级向量：标题/作者/出处/分类 + 首页文本。查询匹配论文主题但没有任何单块强命中时，靠它把论文捞回来
      const meta =
        `Title: ${p.title}\nAuthors: ${p.authors}\nVenue: ${p.venue}\nCategory: ${catLabel(p.category)}\n\n` +
        firstPage.replace(/\s+/g, ' ').slice(0, 1400)
      const { vectors } = await embed([meta])
      const buf = Buffer.from(new Float32Array(vectors[0]).buffer)
      setPvec.run(buf, p.id)
      setFts.run(p.id, p.title, p.authors, p.venue, p.slug)
    }
    const total = todo.length
    startMaxId = (db.prepare('SELECT MAX(id) AS m FROM papers').get() as { m: number | null }).m ?? 0
    send('index:progress', { done: 0, total, phase: 'indexing' })
    const insChunk = db.prepare('INSERT INTO chunks(paper_id,page,ord,text,vec,section_no,section_title,kind) VALUES(?,?,?,?,?,?,?,?)')
    // rowid 显式写 chunks.id：两表主键不同步（chunks 是 AUTOINCREMENT，重建后继续累加；
    // fts5 rowid 清空后从 1 重来），不显式对齐的话重建一次 BM25 召回就会错位
    const insFts = db.prepare('INSERT INTO chunks_fts(rowid,text,paper_id,page) VALUES(?,?,?,?)')
    const mark = db.prepare('UPDATE papers SET indexed=1, n_pages=? WHERE id=?')

    for (let t = 0; t < todo.length; t++) {
      const { id, path, slug, category } = todo[t]
      try {
        const pages = await extractPages(path)
        // 结构化解析：liteparse 逐页 markdown → 三层分块（章节元数据+页码）；
        // 解析失败回退 pdfjs 逐页分块
        let jobs: ChunkJob[] = []
        const mdPages = await runLiteparse(path)
        if (mdPages) jobs = chunkMdBlocks(parseMdBlockPages(mdPages))
        else console.warn(`[index] ${slug} liteparse 失败，回退内置分块`)
        if (!jobs.length) jobs = chunkPages(pages)
        for (let i = 0; i < jobs.length; i += 16) {
          const batch = jobs.slice(i, i + 16)
          // 嵌入文本带分类前缀 + 论点句/重叠（库内仍存干净原文）
          const { vectors } = await embed(batch.map((b) => `【分类：${catLabel(category)}】${b.embedText}`))
          const tx = db.transaction(() => {
            for (let j = 0; j < batch.length; j++) {
              const v = vectors[j]
              const buf = Buffer.from(new Float32Array(v).buffer)
              const r = insChunk.run(id, batch[j].page, batch[j].ord, batch[j].text, buf, batch[j].sectionNo, batch[j].sectionTitle, batch[j].kind)
              insFts.run(Number(r.lastInsertRowid), batch[j].text, id, batch[j].page)
            }
          })
          tx()
        }
        mark.run(pages.length, id)
        try {
          await paperVec(todo[t], pages[0] ?? '')
        } catch (e) {
          console.error(`[index] ${slug} 整篇向量失败:`, e)
        }
      } catch (err) {
        console.error(`[index] ${slug} 失败:`, err)
      }
      send('index:progress', { done: t + 1, total, phase: 'indexing', current: slug })
    }
    // 升级路径：正文块已是最新、但整篇级向量/标题索引缺失的老论文，只补首页抽取
    const left = db
      .prepare(
        `SELECT id, path, slug, title, authors, venue, category FROM papers p
         WHERE pvec IS NULL OR p.id NOT IN (SELECT rowid FROM papers_fts) ORDER BY id`
      )
      .all() as Array<{ id: number; path: string; slug: string; title: string; authors: string; venue: string; category: string }>
    for (let t = 0; t < left.length; t++) {
      const p = left[t]
      try {
        const first = await extractPages(p.path, 1)
        await paperVec(p, first[0] ?? '')
      } catch (err) {
        console.error(`[index] ${p.slug} 整篇索引失败:`, err)
        // 失败也要写占位，否则每次启动 indexNeedsRebuild 都为真、无限重试；pvec 留空向量同样无害
        try {
          setFts.run(p.id, p.title, p.authors, p.venue, p.slug)
        } catch {
          /* 忽略 */
        }
        try {
          setPvec.run(Buffer.alloc(0), p.id)
        } catch {
          /* 忽略 */
        }
      }
      send('index:progress', { done: t + 1, total: left.length, phase: 'meta', current: p.slug })
    }
    send('index:progress', { done: total, total, phase: 'done' })
  } finally {
    running = false
  }
  // 本轮索引运行期间新入库的论文（导入触发时正在建索引会被 isIndexRunning 挡掉）：
  // 结束后立即再排一轮，不必等 4 分钟定时重扫。只看 id > startMaxId 的新行，
  // 避免永久失败的旧论文把续跑变成热循环
  const pend = getDb().prepare('SELECT COUNT(*) AS n FROM papers WHERE indexed=0 AND id > ?').get(startMaxId) as { n: number }
  if (pend.n > 0) {
    setTimeout(() => {
      void buildIndex(send).catch((e) => console.error('[index-requeue]', e))
    }, 600)
  }
}

export interface RetrievedChunk {
  paperId: number
  slug: string
  title: string
  category: string
  year: number | null
  page: number
  text: string
  score: number
  // 命中块原文开头（供引用跳转定位到页内真实段落）
  snippet: string
  // v4 结构化分块：章节元数据（marker 引擎；内置路径为空）
  sectionNo: string
  sectionTitle: string
  kind: string
}

// 分类显示名：inbox 是「未分类」的内部目录名
const catLabel = (c: string): string => (c === 'inbox' ? '未分类' : c)

// 混合检索管线：查询预处理（意图加权）→ 向量 top-50 + BM25 top-50（RRF 融合去重）
// → 同章节聚合加成 → 交叉编码器重排（top-N → topK）→ 整篇级召回兜底。
// scopePaperId / category / paperIds 过滤检索范围；单篇来源上限 4。
export async function hybridSearch(
  pq: PreparedQuery,
  scopePaperId?: number,
  topK = 12,
  category?: string,
  paperIds?: number[]
): Promise<RetrievedChunk[]> {
  const db = getDb()
  let papers = db
    .prepare('SELECT id, slug, title, category, year FROM papers')
    .all() as Array<{ id: number; slug: string; title: string; category: string; year: number | null }>
  if (category) {
    const allowed = new Set(db.prepare('SELECT id FROM papers WHERE category=?').all(category).map((r: any) => r.id))
    papers = papers.filter((p) => allowed.has(p.id))
  }
  // 勾选文献范围（阅读模式侧栏「加入对话检索」）：只在所选论文内召回
  const scopeSet = paperIds?.length ? new Set(paperIds) : null
  if (scopeSet) papers = papers.filter((p) => scopeSet.has(p.id))
  const paperById = new Map(papers.map((p) => [p.id, p]))

  // 意图路由权重：精确匹配（术语/型号/标题命中）加重 BM25，语义关联加重向量
  const vw = pq.intent === 'exact' ? 0.75 : 1
  const bw = pq.intent === 'exact' ? 1.25 : 1
  const rrf = new Map<number, number>()
  const bump = (id: number, rank: number, w: number): void => {
    rrf.set(id, (rrf.get(id) ?? 0) + w / (60 + rank))
  }

  // 向量召回（用改写/扩展后的查询）
  const { vectors } = await embed([pq.query])
  const qv = vectors[0]
  const rows = db
    .prepare(
      `SELECT c.id, c.paper_id, c.page, c.vec FROM chunks c
       WHERE (? IS NULL OR c.paper_id IN (SELECT id FROM papers WHERE category=?))`
    )
    .all(category ?? null, category ?? '') as Array<{ id: number; paper_id: number; page: number; vec: Buffer }>
  const scored: Array<{ id: number; s: number }> = []
  // 每篇论文的最强块：整篇级相关度 = max(块余弦)（在全部块上统计，不受 top-50 截断影响）
  const bestByPaper = new Map<number, { chunkId: number; max: number }>()
  for (const r of rows) {
    if (scopePaperId && r.paper_id !== scopePaperId) continue
    if (scopeSet && !scopeSet.has(r.paper_id)) continue
    const fv = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
    const sc = cosf(qv, fv)
    scored.push({ id: r.id, s: sc })
    const b = bestByPaper.get(r.paper_id)
    if (!b || sc > b.max) bestByPaper.set(r.paper_id, { chunkId: r.id, max: sc })
  }
  scored.sort((a, b) => b.s - a.s)
  scored.slice(0, 50).forEach((x, i) => bump(x.id, i, vw))

  // BM25 召回（trigram 对中英文子串都有效）：关键词 OR 查询，top-50；
  // 范围过滤用一次 IN 查询映射完成，不再逐行回查
  try {
    const fts = db
      .prepare(`SELECT f.rowid FROM chunks_fts f WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 50`)
      .all(pq.ftsQuery) as Array<{ rowid: number }>
    const ids = fts.map((f) => Number(f.rowid))
    if (ids.length) {
      const ph = ids.map(() => '?').join(',')
      const rows2 = db.prepare(`SELECT id, paper_id FROM chunks WHERE id IN (${ph})`).all(...ids) as Array<{
        id: number
        paper_id: number
      }>
      const pidOf = new Map(rows2.map((r) => [r.id, r.paper_id]))
      let rank = 0
      for (const x of fts) {
        const pid = pidOf.get(Number(x.rowid))
        if (pid === undefined) continue
        if (scopePaperId && pid !== scopePaperId) continue
        if (scopeSet && !scopeSet.has(pid)) continue
        bump(Number(x.rowid), rank++, bw)
      }
    }
  } catch {
    /* 查询词过短或无匹配时忽略 */
  }

  // RRF 融合 + 同章节聚合加成：同一篇同一章的多处命中互抬（"同章节的块优先"）
  const fused = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 240)
  const secOf = new Map<number, { pid: number; sec: string }>()
  if (fused.length) {
    const ph = fused.map(() => '?').join(',')
    const rows3 = db.prepare(`SELECT id, paper_id, section_no FROM chunks WHERE id IN (${ph})`).all(...fused.map((f) => f[0])) as Array<{
      id: number
      paper_id: number
      section_no: string | null
    }>
    for (const r of rows3) secOf.set(r.id, { pid: r.paper_id, sec: r.section_no ?? '' })
  }
  const groupScore = new Map<string, number>()
  for (const [id, sc] of fused) {
    const m = secOf.get(id)
    if (!m || !m.sec) continue
    const key = `${m.pid}|${m.sec}`
    groupScore.set(key, (groupScore.get(key) ?? 0) + sc)
  }
  const boosted = fused
    .map(([id, sc]) => {
      const m = secOf.get(id)
      const g = m && m.sec ? (groupScore.get(`${m.pid}|${m.sec}`) ?? 0) : 0
      return { id, s: sc + 0.08 * g }
    })
    .sort((a, b) => b.s - a.s)

  // 精排：融合 top-N 候选 → 交叉编码器逐对打分 → 按分数重排。
  // GPU 可用 = 完整策略（40 候选 + 单篇上限 4 + 补齐）；仅 CPU = 轻量（24 候选直取）。
  // 关闭/失败/超时按融合序兜底
  let ordered = boosted
  const lite = rerankDevice() === 'cpu'
  const candN = lite ? LITE_CANDIDATES : RERANK_CANDIDATES
  if (rerankEnabled() && boosted.length > 1) {
    const cands = boosted.slice(0, candN)
    const ph = cands.map(() => '?').join(',')
    const crows = db.prepare(`SELECT id, text FROM chunks WHERE id IN (${ph})`).all(...cands.map((c) => c.id)) as Array<{
      id: number
      text: string
    }>
    const textOf = new Map(crows.map((r) => [r.id, r.text]))
    const scores = await rerankChunks(
      pq.query,
      cands.filter((c) => textOf.has(c.id)).map((c) => ({ id: c.id, text: textOf.get(c.id)! }))
    )
    if (scores) {
      ordered = [...cands].sort((a, b) => (scores.get(b.id) ?? -1e9) - (scores.get(a.id) ?? -1e9)).concat(boosted.slice(candN))
    }
  }

  const getChunk = db.prepare('SELECT paper_id, page, ord, text, section_no, section_title, kind FROM chunks WHERE id=?')
  // 上下文扩展只并同章节相邻块（ord 全局连续），跨章内容会稀释语义
  const getNeighbor = db.prepare('SELECT text FROM chunks WHERE paper_id=? AND ord=? AND id<>? AND section_no=?')
  const makeSource = (
    id: number,
    pid: number,
    page: number,
    ord: number,
    text: string,
    sectionNo: string,
    sectionTitle: string,
    kind: string,
    sc: number,
    paper: { slug: string; title: string; category: string; year: number | null }
  ): RetrievedChunk => {
    let full = text
    for (const [od, pre] of [
      [ord - 1, true],
      [ord + 1, false]
    ] as Array<[number, boolean]>) {
      if (full.length > 4500) break
      const n = getNeighbor.get(pid, od, id, sectionNo) as { text: string } | undefined
      if (n) full = pre ? `${n.text}（前接）
${full}` : `${full}
${n.text}`
    }
    return {
      paperId: pid,
      slug: paper.slug,
      title: paper.title,
      category: paper.category,
      year: paper.year,
      page,
      text: full,
      score: sc,
      snippet: text.slice(0, 600),
      sectionNo,
      sectionTitle,
      kind
    }
  }
  const pick = (id: number, sc: number): RetrievedChunk | null => {
    const c = getChunk.get(id) as
      | { paper_id: number; page: number; ord: number; text: string; section_no: string | null; section_title: string | null; kind: string | null }
      | undefined
    if (!c) return null
    const p = paperById.get(c.paper_id)
    if (!p) return null // 孤儿块（论文行已删但块残留），跳过
    if (scopePaperId && c.paper_id !== scopePaperId) return null
    return makeSource(id, c.paper_id, c.page, c.ord, c.text, c.section_no ?? '', c.section_title ?? '', c.kind ?? 'body', sc, p)
  }

  const out: RetrievedChunk[] = []
  if (scopePaperId || lite) {
    // 整篇内检索 / CPU 轻量策略：按序直取
    for (const o of ordered) {
      if (out.length >= topK) break
      const src = pick(o.id, o.s)
      if (src) out.push(src)
    }
    if (scopePaperId) return out
  } else {
    // 全库完整策略：单篇来源数上限（4），避免一两篇强匹配论文吃掉全部名额、其他相关论文全部缺席
    const PER_PAPER = 4
    const perPaper = new Map<number, number>()
    let i = 0
    for (; i < ordered.length && out.length < topK; i++) {
      const src = pick(ordered[i].id, ordered[i].s)
      if (!src) continue
      const n = perPaper.get(src.paperId) ?? 0
      if (n >= PER_PAPER) continue
      perPaper.set(src.paperId, n + 1)
      out.push(src)
    }
    // 名额没填满（都被上限挡住）就放开上限补齐
    for (; i < ordered.length && out.length < topK; i++) {
      const src = pick(ordered[i].id, ordered[i].s)
      if (src) out.push(src)
    }
  }

  // 整篇级召回：max(块余弦, 整篇向量余弦) + 标题/作者命中加成，选出尚未出现的最相关论文，
  // 注入其最强块作为来源（上限 4，total 最多 topK+4）；不参与重排，用余弦分数
  let titleHits = new Set<number>()
  try {
    const hits = db
      .prepare(`SELECT rowid FROM papers_fts WHERE papers_fts MATCH ? ORDER BY bm25(papers_fts) LIMIT 40`)
      .all(pq.ftsQuery) as Array<{ rowid: number }>
    titleHits = new Set(hits.map((h) => h.rowid).filter((pid) => paperById.has(pid)))
  } catch {
    /* 短查询/无命中忽略 */
  }
  const pvecs = new Map<number, Float32Array>()
  for (const r of db.prepare('SELECT id, pvec FROM papers').all() as Array<{ id: number; pvec: Buffer | null }>) {
    if (r.pvec && r.pvec.byteLength > 0 && paperById.has(r.id)) {
      pvecs.set(r.id, new Float32Array(r.pvec.buffer, r.pvec.byteOffset, r.pvec.byteLength / 4))
    }
  }
  const covered = new Set(out.map((o) => o.paperId))
  const candPids = new Set<number>()
  for (const pid of bestByPaper.keys()) if (!covered.has(pid)) candPids.add(pid)
  for (const pid of pvecs.keys()) if (!covered.has(pid)) candPids.add(pid)
  const cand = [...candPids]
    .map((pid) => {
      const b = bestByPaper.get(pid)
      const pv = pvecs.get(pid)
      return { pid, b, s: Math.max(b?.max ?? -1, pv ? cosf(qv, pv) : -1) + (titleHits.has(pid) ? 0.35 : 0) }
    })
    .sort((a, b) => b.s - a.s)
  for (const c of cand) {
    if (out.length >= topK + 4) break
    if (c.b) {
      const src = pick(c.b.chunkId, c.s)
      if (src) out.push(src)
    } else {
      // 没有正文块的论文（抽取曾失败）：至少以元数据来源出现，保证"检索不到"不会因缺块发生
      const p = paperById.get(c.pid)
      if (p && c.s > 0.3) {
        out.push({
          paperId: c.pid,
          slug: p.slug,
          title: p.title,
          category: p.category,
          year: p.year,
          page: 1,
          text: `${p.title}（正文索引缺失，仅元数据命中）`,
          score: c.s,
          snippet: '',
          sectionNo: '',
          sectionTitle: '',
          kind: 'meta'
        })
      }
    }
  }
  return out
}

function cosf(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

export function settingsDirtyForIndex(): boolean {
  return !!getSettings().libraryPath
}
