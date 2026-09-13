import fs from 'node:fs'
import path from 'node:path'
import { getDb, getSettings } from './db'
import { embed } from './embed'

let running = false

export function isIndexRunning(): boolean {
  return running
}

// 分块算法版本：改动分块逻辑时递增，buildIndex 检测到旧版本索引会自动清空重建
const CHUNK_VERSION = 2

// 库是否需要（重新）索引：有待索引论文、分块算法版本落后，或整篇级向量/标题索引缺失
export function indexNeedsRebuild(): boolean {
  const db = getDb()
  const pending = db.prepare('SELECT COUNT(*) AS n FROM papers WHERE indexed=0').get() as { n: number }
  if (pending.n > 0) return true
  const v = db.prepare("SELECT value FROM meta WHERE key='chunk_v'").get() as { value: string } | undefined
  if (!v || v.value !== String(CHUNK_VERSION)) return true
  const noPvec = db.prepare('SELECT COUNT(*) AS n FROM papers WHERE pvec IS NULL').get() as { n: number }
  if (noPvec.n > 0) return true
  const noFts = db
    .prepare('SELECT COUNT(*) AS n FROM papers p LEFT JOIN papers_fts f ON f.rowid=p.id WHERE p.indexed=1 AND f.rowid IS NULL')
    .get() as { n: number }
  return noFts.n > 0
}

// v2 分块：按行（近似段落）聚合到 ~1200 字符，避免把句子/段落从中间截断，
// 嵌入向量与检索片段的语义边界都更干净；单行超长时才在句读处硬切
function chunkText(text: string): string[] {
  const out: string[] = []
  const target = 1200
  const hardMax = 1600
  let buf = ''
  const push = (): void => {
    const piece = buf.trim()
    if (piece.length > 40) out.push(piece)
    buf = ''
  }
  for (const line of text.split('\n')) {
    // 单行超过硬上限：先尽量在句号/分号处断开，兜底按长度切
    if (line.length > hardMax) {
      if (buf) push()
      let rest = line
      while (rest.length > hardMax) {
        const window = rest.slice(0, hardMax)
        let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('。'), window.lastIndexOf('; '))
        if (cut < target * 0.4) cut = hardMax
        out.push(rest.slice(0, cut + 1).trim())
        rest = rest.slice(cut + 1)
      }
      buf = rest
      continue
    }
    if (buf.length + line.length > target) push()
    buf += (buf ? '\n' : '') + line
  }
  if (buf) push()
  return out
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
  return pages
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
  try {
    const db = getDb()
    const { dim } = await embed(['warmup'])
    const prevDim = db.prepare("SELECT value FROM meta WHERE key='embed_dim'").get() as { value: string } | undefined
    const prevV = db.prepare("SELECT value FROM meta WHERE key='chunk_v'").get() as { value: string } | undefined
    if ((prevDim && parseInt(prevDim.value) !== dim) || prevV?.value !== String(CHUNK_VERSION)) {
      // 嵌入维度变化或分块算法升级：旧块不可比，清空全库重建（含整篇级向量/标题索引）
      db.exec('DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM papers_fts; UPDATE papers SET indexed=0, pvec=NULL')
    }
    db.prepare("INSERT INTO meta(key,value) VALUES('embed_dim',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(dim))
    db.prepare("INSERT INTO meta(key,value) VALUES('chunk_v',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(CHUNK_VERSION))

    const todo = db.prepare('SELECT id, path, slug, title, authors, venue FROM papers WHERE indexed=0 ORDER BY id').all() as Array<{
      id: number
      path: string
      slug: string
      title: string
      authors: string
      venue: string
    }>
    const setPvec = db.prepare('UPDATE papers SET pvec=? WHERE id=?')
    const setFts = db.prepare('INSERT OR REPLACE INTO papers_fts(rowid,title,authors,venue,slug) VALUES(?,?,?,?,?)')
    const paperVec = async (
      p: { id: number; slug: string; title: string; authors: string; venue: string },
      firstPage: string
    ): Promise<void> => {
      // 整篇级向量：标题/作者/出处 + 首页文本。查询匹配论文主题但没有任何单块强命中时，靠它把论文捞回来
      const meta =
        `Title: ${p.title}\nAuthors: ${p.authors}\nVenue: ${p.venue}\n\n` +
        firstPage.replace(/\s+/g, ' ').slice(0, 1400)
      const { vectors } = await embed([meta])
      const buf = Buffer.from(new Float32Array(vectors[0]).buffer)
      setPvec.run(buf, p.id)
      setFts.run(p.id, p.title, p.authors, p.venue, p.slug)
    }
    const total = todo.length
    send('index:progress', { done: 0, total, phase: 'indexing' })
    const insChunk = db.prepare('INSERT INTO chunks(paper_id,page,ord,text,vec) VALUES(?,?,?,?,?)')
    // rowid 显式写 chunks.id：两表主键不同步（chunks 是 AUTOINCREMENT，重建后继续累加；
    // fts5 rowid 清空后从 1 重来），不显式对齐的话重建一次 BM25 召回就会错位
    const insFts = db.prepare('INSERT INTO chunks_fts(rowid,text,paper_id,page) VALUES(?,?,?,?)')
    const mark = db.prepare('UPDATE papers SET indexed=1, n_pages=? WHERE id=?')

    for (let t = 0; t < todo.length; t++) {
      const { id, path, slug } = todo[t]
      try {
        const pages = await extractPages(path)
        const jobs: Array<{ page: number; ord: number; text: string }> = []
        for (let p = 0; p < pages.length; p++) {
          const parts = chunkText(pages[p])
          for (let o = 0; o < parts.length; o++) jobs.push({ page: p + 1, ord: o, text: parts[o] })
        }
        for (let i = 0; i < jobs.length; i += 16) {
          const batch = jobs.slice(i, i + 16)
          const { vectors } = await embed(batch.map((b) => b.text))
          const tx = db.transaction(() => {
            for (let j = 0; j < batch.length; j++) {
              const v = vectors[j]
              const buf = Buffer.from(new Float32Array(v).buffer)
              const r = insChunk.run(id, batch[j].page, batch[j].ord, batch[j].text, buf)
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
        `SELECT id, path, slug, title, authors, venue FROM papers p
         WHERE pvec IS NULL OR p.id NOT IN (SELECT rowid FROM papers_fts) ORDER BY id`
      )
      .all() as Array<{ id: number; path: string; slug: string; title: string; authors: string; venue: string }>
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
}

export interface RetrievedChunk {
  paperId: number
  slug: string
  title: string
  page: number
  text: string
  score: number
  // 命中块原文开头（供引用跳转定位到页内真实段落）
  snippet: string
}

// 混合检索：向量余弦 + FTS5(trigram) BM25，RRF 融合；scopePaperId / category 过滤范围。
// 全库模式分两层召回：段落块负责精确定位（引用带页码与原文），
// 整篇级（每篇最优块余弦 + 标题/作者 BM25）保证"这篇论文相关"就一定出现在来源里——
// 否则一篇强相关论文可能因为没有单块挤进前列而永远检索不到
export async function hybridSearch(query: string, scopePaperId?: number, topK = 12, category?: string): Promise<RetrievedChunk[]> {
  const db = getDb()
  let papers = db.prepare('SELECT id, slug, title FROM papers').all() as Array<{ id: number; slug: string; title: string }>
  if (category) {
    const allowed = new Set(db.prepare('SELECT id FROM papers WHERE category=?').all(category).map((r: any) => r.id))
    papers = papers.filter((p) => allowed.has(p.id))
  }
  const paperById = new Map(papers.map((p) => [p.id, p]))

  const rrf = new Map<number, number>()
  const bump = (id: number, rank: number) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (60 + rank))

  // 向量召回
  const { vectors } = await embed([query], true)
  const qv = vectors[0]
  const rows = db
    .prepare(
      `SELECT c.id, c.paper_id, c.page, c.vec FROM chunks c
       WHERE (? IS NULL OR c.paper_id IN (SELECT id FROM papers WHERE category=?))`
    )
    .all(category ?? null, category ?? '') as Array<{ id: number; paper_id: number; page: number; vec: Buffer }>
  const scored: Array<{ id: number; s: number }> = []
  // 每篇论文的最强块：整篇级相关度 = max(块余弦)（在全部块上统计，不受 top-60 截断影响）
  const bestByPaper = new Map<number, { chunkId: number; max: number }>()
  for (const r of rows) {
    if (scopePaperId && r.paper_id !== scopePaperId) continue
    const fv = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
    const s = cosf(qv, fv)
    scored.push({ id: r.id, s })
    const b = bestByPaper.get(r.paper_id)
    if (!b || s > b.max) bestByPaper.set(r.paper_id, { chunkId: r.id, max: s })
  }
  scored.sort((a, b) => b.s - a.s)
  scored.slice(0, 60).forEach((x, i) => bump(x.id, i))

  // BM25 召回（trigram 对中英文子串都有效）
  try {
    const fts = db
      .prepare(
        `SELECT f.rowid FROM chunks_fts f
         WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 200`
      )
      .all(query) as Array<{ rowid: number }>
    const inScope = (rowid: number): boolean => {
      const c = db.prepare('SELECT paper_id, category FROM chunks JOIN papers ON papers.id=chunks.paper_id WHERE chunks.id=?').get(rowid) as
        | { paper_id: number; category: string }
        | undefined
      if (!c) return false
      if (scopePaperId && c.paper_id !== scopePaperId) return false
      if (category && c.category !== category) return false
      return true
    }
    fts.forEach((x, i) => {
      if (inScope(x.rowid)) bump(x.rowid, i)
    })
  } catch {
    /* 查询词过短或无匹配时忽略 */
  }

  const top = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK * 3)
  const getChunk = db.prepare('SELECT paper_id, page, ord, text FROM chunks WHERE id=?')
  const getNeighbor = db.prepare('SELECT text FROM chunks WHERE paper_id=? AND page=? AND ord=? AND id<>?')
  const makeSource = (id: number, pid: number, page: number, ord: number, text: string, s: number, paper: { slug: string; title: string }): RetrievedChunk => {
    // 上下文扩展：并入相邻块，让每个来源不只是孤立片段
    let full = text
    for (const [pg, od, pre] of [
      [page, ord - 1, true],
      [page, ord + 1, false],
      [page + 1, 0, false]
    ] as Array<[number, number, boolean]>) {
      if (full.length > 4500) break
      const n = getNeighbor.get(pid, pg, od, id) as { text: string } | undefined
      if (n) full = pre ? `${n.text}（前接）
${full}` : `${full}
${n.text}`
    }
    return { paperId: pid, slug: paper.slug, title: paper.title, page, text: full, score: s, snippet: text.slice(0, 600) }
  }
  const pick = (id: number, s: number): RetrievedChunk | null => {
    const c = getChunk.get(id) as { paper_id: number; page: number; ord: number; text: string } | undefined
    if (!c) return null
    const p = paperById.get(c.paper_id)
    if (!p) return null // 孤儿块（论文行已删但块残留），跳过
    if (scopePaperId && c.paper_id !== scopePaperId) return null
    return makeSource(id, c.paper_id, c.page, c.ord, c.text, s, p)
  }

  const out: RetrievedChunk[] = []
  if (scopePaperId) {
    for (const [id, s] of top) {
      const src = pick(id, s)
      if (src) out.push(src)
      if (out.length >= topK) break
    }
    return out
  }

  // 全库：单篇来源数设上限（4），避免一两篇强匹配论文吃掉全部名额、其他相关论文全部缺席
  const PER_PAPER = 4
  const perPaper = new Map<number, number>()
  let i = 0
  for (; i < top.length && out.length < topK; i++) {
    const src = pick(top[i][0], top[i][1])
    if (!src) continue
    const n = perPaper.get(src.paperId) ?? 0
    if (n >= PER_PAPER) continue
    perPaper.set(src.paperId, n + 1)
    out.push(src)
  }
  // 名额没填满（都被上限挡住）就放开上限补齐
  for (; i < top.length && out.length < topK; i++) {
    const src = pick(top[i][0], top[i][1])
    if (src) out.push(src)
  }

  // 整篇级召回：max(块余弦, 整篇向量余弦) + 标题/作者命中加成，选出尚未出现的最相关论文，
  // 注入其最强块作为来源（上限 4，total 最多 topK+4）
  let titleHits = new Set<number>()
  try {
    const hits = db
      .prepare(`SELECT rowid FROM papers_fts WHERE papers_fts MATCH ? ORDER BY bm25(papers_fts) LIMIT 40`)
      .all(query) as Array<{ rowid: number }>
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
        out.push({ paperId: c.pid, slug: p.slug, title: p.title, page: 1, text: `${p.title}（正文索引缺失，仅元数据命中）`, score: c.s, snippet: '' })
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
