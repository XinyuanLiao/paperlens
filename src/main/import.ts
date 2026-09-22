import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { getDb, getSettings, scanLibrary, setExtraCats, getExtraCats } from './db'
import { extractPages } from './ingest'
import { chatStream } from './llm'

export interface ImportOutcome {
  file: string
  // 源文件完整路径（弹窗按它精确匹配队列行，避免不同目录同名文件错位）
  path?: string
  ok: boolean
  slug?: string
  title?: string
  category?: string
  classified: boolean
  error?: string
}

function titleFromFilename(p: string): { base: string; year: number | null } {
  const base = path.basename(p, path.extname(p))
  const ym = base.match(/(19|20)\d{2}/)
  return { base, year: ym ? parseInt(ym[0]) : null }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'paper'
  )
}

async function classify(firstPages: string): Promise<{
  title: string
  authors: string
  year: number | null
  venue: string
  categorySlug: string
  paperSlug: string
} | null> {
  const db = getDb()
  const cats = [...new Set((db.prepare('SELECT category FROM papers').all() as Array<{ category: string }>).map((r) => r.category))]
  const prompt =
    `你是文献管理助手。根据论文首页文本，把它归入最合适的分类。` +
    `现有分类（可直接使用，去掉编号前缀）：${cats.join('、')}。` +
    `如果都不合适，提议一个新的英文短分类（kebab-case，不超过 4 个单词）。` +
    `只输出 JSON，格式：{"title":"英文标题","authors":"A, B, C et al.","year":2024,"venue":"期刊/会议或arXiv","category_slug":"tsfm-foundations","paper_slug":"2024-短名-kebab"}。` +
    `paper_slug 以年份开头，不超过 5 个单词。不要输出任何其他内容。`
  let out = ''
  for await (const d of chatStream([
    { role: 'system', content: prompt },
    { role: 'user', content: firstPages.slice(0, 4000) }
  ])) {
    out += d
  }
  try {
    const json = JSON.parse(out.replace(/^```json\s*|```\s*$/g, ''))
    if (!json.title || !json.category_slug) return null
    return {
      title: String(json.title),
      authors: String(json.authors ?? ''),
      year: parseInt(json.year) || null,
      venue: String(json.venue ?? ''),
      categorySlug: slugify(String(json.category_slug)),
      paperSlug: String(json.paper_slug ?? '')
    }
  } catch {
    return null
  }
}

// 分类名只做文件系统安全清洗（保留中文），不像 slug 那样限制为 a-z0-9-
export function sanitizeCategoryName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 40)
  )
}

const eqName = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

function nextCategoryDir(libPapers: string, name: string): string {
  const nums = fs
    .readdirSync(libPapers)
    .map((d) => parseInt(d.match(/^(\d+)-/)?.[1] ?? '0'))
    .filter((n) => !isNaN(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return path.join(libPapers, `${String(next).padStart(2, '0')}-${name}`)
}

// 分类目录名 = NN-<分类名>；按去掉编号前缀后的名字匹配（大小写不敏感，兼容历史英文 slug）
export function findCategoryDir(libPapers: string, name: string): string | null {
  const hit = fs
    .readdirSync(libPapers)
    .filter((d) => !d.startsWith('.') && fs.statSync(path.join(libPapers, d)).isDirectory())
    .find((d) => eqName(d.replace(/^\d+-/, ''), name))
  return hit ? path.join(libPapers, hit) : null
}

// 展开导入路径里的目录（递归收集 PDF），并剔除文献库自身（把库拖进来等于自我复制）
function expandFiles(paths: string[], libraryPath: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const under = (p: string): boolean => {
    const a = path.resolve(p).toLowerCase()
    const l = path.resolve(libraryPath).toLowerCase()
    return a === l || a.startsWith(l + path.sep)
  }
  const walk = (p: string, depth: number): void => {
    if (out.length >= 800) return
    const st = fs.statSync(p)
    if (st.isFile()) {
      if (p.toLowerCase().endsWith('.pdf') && !under(p)) {
        const key = path.resolve(p).toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          out.push(p)
        }
      }
      return
    }
    if (!st.isDirectory() || depth > 3 || under(p)) return
    for (const e of fs.readdirSync(p)) walk(path.join(p, e), depth + 1)
  }
  for (const p of paths) {
    try {
      walk(p, 0)
    } catch {
      /* 单路径失败跳过 */
    }
  }
  return out
}

// ---------- 导入预检：先逐篇识别推荐分类，用户确认/调整后再导入 ----------
// 识别结果缓存（按 mtime 失效）：预检跑过的文件导入时直接复用，不重复调 AI
interface ClassifyInfo {
  title: string
  authors: string
  year: number | null
  venue: string
  categorySlug: string
  paperSlug: string
  mtime: number
}
const classifyCache = new Map<string, ClassifyInfo>()

async function classifyCached(src: string): Promise<ClassifyInfo | null> {
  let mtime = 0
  try {
    mtime = fs.statSync(src).mtimeMs
  } catch {
    /* 读取失败让 extractPages 报具体错误 */
  }
  const hit = classifyCache.get(src)
  if (hit && hit.mtime === mtime) return hit
  const pages = await extractPages(src, 2)
  const info = await classify(pages.slice(0, 2).join('\n'))
  if (!info) return null
  const full = { ...info, mtime }
  classifyCache.set(src, full)
  return full
}

export interface PreviewItem {
  file: string
  path: string
  ok: boolean
  category?: string
  title?: string
  error?: string
}

// 与导入共用串行链：预检没跑完时导入排在其后，缓存结果直接复用
export function previewImport(paths: string[], send: (ev: string, p: unknown) => void): Promise<PreviewItem[]> {
  const run = importChain.catch(() => undefined).then(() => previewImportInternal(paths, send))
  importChain = run.catch(() => undefined)
  return run
}

async function previewImportInternal(paths: string[], send: (ev: string, p: unknown) => void): Promise<PreviewItem[]> {
  const s = getSettings()
  const files = expandFiles(paths, s.libraryPath)
  const out: PreviewItem[] = []
  for (let i = 0; i < files.length; i++) {
    const src = files[i]
    send('preview:progress', { done: i, total: files.length, current: path.basename(src) })
    let item: PreviewItem
    if (!s.apiKey) {
      item = { file: path.basename(src), path: src, ok: true, category: 'inbox' }
    } else {
      try {
        const info = await classifyCached(src)
        item = info
          ? { file: path.basename(src), path: src, ok: true, category: info.categorySlug, title: info.title }
          : { file: path.basename(src), path: src, ok: false, error: 'AI 未返回有效结果，导入时将放入未分类' }
      } catch (err) {
        item = { file: path.basename(src), path: src, ok: false, error: String(err) }
      }
    }
    out.push(item)
    send('preview:file', item)
  }
  send('preview:progress', { done: files.length, total: files.length, current: '' })
  return out
}

export interface ImportItem {
  path: string
  // 逐篇目标分类：'' = AI 自动推荐；'inbox' = 未分类；其余为分类名
  category?: string
}

function normalizeItems(items: Array<string | ImportItem>): ImportItem[] {
  return items.map((x) => (typeof x === 'string' ? { path: x } : x))
}

// 导入串行化：窗口拖入/弹窗/文件夹导入可能并发触发，链式排队避免 copy+scan 互相踩
let importChain: Promise<unknown> = Promise.resolve()
export function importPapers(items: Array<string | ImportItem>, send: (ev: string, p: unknown) => void): Promise<ImportOutcome[]> {
  const run = importChain.catch(() => undefined).then(() => importPapersInternal(normalizeItems(items), send))
  importChain = run.catch(() => undefined)
  return run
}

async function importPapersInternal(items: ImportItem[], send: (ev: string, p: unknown) => void): Promise<ImportOutcome[]> {
  const s = getSettings()
  const libPapers = path.join(s.libraryPath, 'papers')
  fs.mkdirSync(libPapers, { recursive: true })
  // 每个文件的目标分类：该项路径（含文件夹展开出的文件）继承其选择；空串 = AI 自动
  const fileCat = new Map<string, string>()
  const files: string[] = []
  const seen = new Set<string>()
  for (const it of items) {
    for (const f of expandFiles([it.path], s.libraryPath)) {
      const key = path.resolve(f).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      fileCat.set(f, it.category ?? '')
      files.push(f)
    }
  }
  const outcomes: ImportOutcome[] = []
  for (let i = 0; i < files.length; i++) {
    const src = files[i]
    send('import:progress', { done: i, total: files.length, current: path.basename(src) })
    const fb = titleFromFilename(src)
    let title = fb.base
    let authors = ''
    let year = fb.year
    let venue = ''
    let categorySlug = 'inbox'
    let paperSlug = slugify(fb.base)
    let classified = false
    let aiCat: string | null = null
    try {
      if (s.apiKey) {
        // 预检过则直接命中缓存；没预检过（拖入即导、AI 中途断开重试）现场识别
        const info = await classifyCached(src)
        if (info) {
          title = info.title
          authors = info.authors
          year = info.year ?? year
          venue = info.venue
          categorySlug = info.categorySlug
          paperSlug = info.paperSlug ? slugify(info.paperSlug) : slugify(`${year ?? ''}-${info.title}`)
          aiCat = info.categorySlug
        }
      }
      // 用户在队列里选了分类就以其为准（与 AI 推荐一致时仍算 AI 归类）
      const manualCat = sanitizeCategoryName(fileCat.get(src) ?? '')
      if (manualCat && manualCat !== 'inbox') {
        categorySlug = manualCat
        classified = manualCat === aiCat
      } else if (manualCat === 'inbox') {
        categorySlug = 'inbox'
      } else if (aiCat) {
        classified = true
      }
      // 目标文件夹：已有分类复用，新分类建 NN-<名称>
      let dir = categorySlug === 'inbox' ? path.join(libPapers, '99-inbox') : findCategoryDir(libPapers, categorySlug)
      if (!dir) dir = nextCategoryDir(libPapers, categorySlug)
      let slug = paperSlug
      let dest = path.join(dir, slug)
      let k = 2
      while (fs.existsSync(dest)) slug = `${paperSlug}-${k++}`, dest = path.join(dir, slug)
      fs.mkdirSync(dest, { recursive: true })
      fs.copyFileSync(src, path.join(dest, 'paper.pdf'))
      const note = `---\ntitle: "${title.replace(/"/g, "'")}"\nauthors: "${authors.replace(/"/g, "'")}"\nyear: ${year ?? 'null'}\nvenue: "${venue.replace(/"/g, "'")}"\ntags: [status/unread]\nstatus: unread\n---\n\n# ${title}\n\n- **作者:** ${authors || '（作者见原文）'}\n- **发表:** ${venue || `${year ?? ''}（待核实）`}\n- **来源:** 本地导入（${path.basename(src)}）${classified ? '，AI 自动归类' : ''}\n\n## 速览\n\n（导入时未生成摘要。）\n\n## 阅读状态\n\n- ${new Date().getFullYear()} 通过应用内导入入库，未精读。\n`
      fs.writeFileSync(path.join(dest, `${slug}.md`), note)
      const oc: ImportOutcome = { file: path.basename(src), path: src, ok: true, slug, title, category: path.basename(dir).replace(/^\d+-/, ''), classified }
      outcomes.push(oc)
      send('import:file', oc)
    } catch (err) {
      const oc: ImportOutcome = { file: path.basename(src), path: src, ok: false, classified: false, error: String(err) }
      outcomes.push(oc)
      send('import:file', oc)
    }
  }
  send('import:progress', { done: files.length, total: files.length, current: '' })
  scanLibrary(s.libraryPath)
  return outcomes
}

// ---------- 手动归类：把论文文件夹移到目标分类（保留行身份，不触发重新嵌入） ----------
export function movePaperToCategory(
  paperId: number,
  categoryName: string,
  libPapers: string
): { category: string; path: string; moved: boolean } | null {
  const db = getDb()
  const p = db.prepare('SELECT id, slug, path FROM papers WHERE id=?').get(paperId) as
    | { id: number; slug: string; path: string }
    | undefined
  if (!p) return null
  const name = sanitizeCategoryName(categoryName)
  if (!name) throw new Error('分类名无效')
  let destDir = findCategoryDir(libPapers, name)
  if (!destDir) destDir = nextCategoryDir(libPapers, name)
  const dest = path.join(destDir, p.slug)
  if (path.resolve(dest) === path.resolve(path.dirname(p.path))) {
    return { category: path.basename(destDir).replace(/^\d+-/, ''), path: p.path, moved: false }
  }
  fs.mkdirSync(destDir, { recursive: true })
  fs.renameSync(path.dirname(p.path), dest) // 整个论文文件夹搬过去
  const newPath = path.join(dest, path.basename(p.path))
  db.prepare('UPDATE papers SET path=?, category=? WHERE id=?').run(newPath, path.basename(destDir).replace(/^\d+-/, ''), paperId)
  return { category: path.basename(destDir).replace(/^\d+-/, ''), path: newPath, moved: true }
}

// 新建空分类：建目录 + 记入 extra_cats（空目录扫描不可见，靠它出现在侧栏与移动菜单里）
export function createCategory(rawName: string, libPapers: string): { name: string; dir: string } {
  const name = sanitizeCategoryName(rawName)
  if (!name) throw new Error('分类名无效（不能为空）')
  let dir = findCategoryDir(libPapers, name)
  if (!dir) {
    dir = nextCategoryDir(libPapers, name)
    fs.mkdirSync(dir, { recursive: true })
  }
  const cats = getExtraCats()
  if (!cats.some((c) => eqName(c, name))) {
    cats.push(name)
    setExtraCats(cats)
  }
  return { name: path.basename(dir).replace(/^\d+-/, ''), dir }
}

// 删除空分类：只允许删没有论文的（目录须为空）；从 extra_cats 摘除
export function deleteCategory(name: string, libPapers: string): boolean {
  const db = getDb()
  const n = (db.prepare('SELECT COUNT(*) AS n FROM papers WHERE category=?').get(name) as { n: number }).n
  if (n > 0) throw new Error(`分类「${name}」还有 ${n} 篇论文，先移走再删除`)
  const dir = findCategoryDir(libPapers, name)
  if (dir) {
    const rest = fs.readdirSync(dir).filter((f) => !f.startsWith('.'))
    if (rest.length > 0) throw new Error(`分类目录不为空（${rest.length} 个文件）`)
    fs.rmdirSync(dir)
  }
  setExtraCats(getExtraCats().filter((c) => !eqName(c, name)))
  return true
}

// ---------- 删除 / 重命名文献 ----------
// 删除：论文文件夹移入系统废纸篓（可找回），DB 行 + 块/向量/FTS/高亮一并清理。
// 外键级联默认关闭且 FTS rowid 与 chunks.id 对齐，全部手动删，避免残留孤儿块污染检索
export async function deletePaper(paperId: number): Promise<void> {
  const db = getDb()
  const p = db.prepare('SELECT id, path FROM papers WHERE id=?').get(paperId) as { id: number; path: string } | undefined
  if (!p) throw new Error('论文不存在（可能已被删除）')
  const dir = path.dirname(p.path)
  try {
    await shell.trashItem(dir)
  } catch {
    fs.rmSync(dir, { recursive: true, force: true }) // 废纸篓不可用（罕见）时直接删除
  }
  const chunkIds = (db.prepare('SELECT id FROM chunks WHERE paper_id=?').all(paperId) as Array<{ id: number }>).map((r) => r.id)
  const tx = db.transaction(() => {
    const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid=?')
    for (const id of chunkIds) delFts.run(id)
    db.prepare('DELETE FROM chunks WHERE paper_id=?').run(paperId)
    db.prepare('DELETE FROM papers_fts WHERE rowid=?').run(paperId)
    db.prepare('DELETE FROM highlights WHERE paper_id=?').run(paperId)
    db.prepare('DELETE FROM chatlog WHERE paper_id=?').run(paperId)
    db.prepare('DELETE FROM papers WHERE id=?').run(paperId)
  })
  tx()
}

// 重命名：只改标题（md 笔记 + DB + 标题索引），不动文件夹名/slug——
// 扫描 upsert 会用 md 里的 title 覆盖 DB，所以 md 必须同步改（缺失就补建），否则下次扫描会还原
export function renamePaper(paperId: number, rawTitle: string): { title: string } {
  const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!title) throw new Error('标题不能为空')
  const db = getDb()
  const p = db
    .prepare('SELECT id, slug, title, authors, year, venue, path FROM papers WHERE id=?')
    .get(paperId) as
    | { id: number; slug: string; title: string; authors: string; year: number | null; venue: string; path: string }
    | undefined
  if (!p) throw new Error('论文不存在（可能已被删除）')
  const dir = path.dirname(p.path)
  let mdPath = path.join(dir, `${p.slug}.md`)
  if (!fs.existsSync(mdPath)) {
    const alt = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.md')) : undefined
    if (alt) mdPath = path.join(dir, alt)
  }
  const safe = title.replace(/"/g, "'")
  const year = p.year ?? 'null'
  if (fs.existsSync(mdPath)) {
    let raw = fs.readFileSync(mdPath, 'utf8')
    if (/^title:.*$/m.test(raw)) raw = raw.replace(/^title:.*$/m, `title: "${safe}"`)
    else raw = raw.replace(/^---\n/, `---\ntitle: "${safe}"\n`)
    if (/^# .+$/m.test(raw)) raw = raw.replace(/^# .+$/m, `# ${safe}`)
    fs.writeFileSync(mdPath, raw)
  } else {
    fs.writeFileSync(
      mdPath,
      `---\ntitle: "${safe}"\nauthors: "${p.authors.replace(/"/g, "'")}"\nyear: ${year}\nvenue: "${p.venue.replace(/"/g, "'")}"\ntags: [status/unread]\nstatus: unread\n---\n\n# ${safe}\n`
    )
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE papers SET title=? WHERE id=?').run(title, paperId)
    // papers_fts 的 rowid 与 papers.id 对齐（buildIndex 同一约定）
    db.prepare('INSERT OR REPLACE INTO papers_fts(rowid,title,authors,venue,slug) VALUES(?,?,?,?,?)').run(
      paperId,
      title,
      p.authors,
      p.venue,
      p.slug
    )
    // 标题变了，整篇级向量（含标题）过期：清掉让索引器只重嵌这一篇的 pvec，正文块不受影响
    db.prepare('UPDATE papers SET pvec=NULL WHERE id=?').run(paperId)
  })
  tx()
  return { title }
}
