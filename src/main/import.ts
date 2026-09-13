import fs from 'node:fs'
import path from 'node:path'
import { getDb, getSettings, scanLibrary } from './db'
import { extractPages } from './ingest'
import { chatStream } from './llm'

export interface ImportOutcome {
  file: string
  ok: boolean
  slug?: string
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

function nextCategoryDir(libPapers: string, slug: string): string {
  const nums = fs
    .readdirSync(libPapers)
    .map((d) => parseInt(d.match(/^(\d+)-/)?.[1] ?? '0'))
    .filter((n) => !isNaN(n))
  const next = (nums.length ? Math.max(...nums) : 0) + 1
  return path.join(libPapers, `${String(next).padStart(2, '0')}-${slug}`)
}

function findCategoryDir(libPapers: string, slug: string): string | null {
  const hit = fs.readdirSync(libPapers).find((d) => d.endsWith(`-${slug}`))
  return hit ? path.join(libPapers, hit) : null
}

export async function importPapers(filePaths: string[], send: (ev: string, p: unknown) => void): Promise<ImportOutcome[]> {
  const s = getSettings()
  const libPapers = path.join(s.libraryPath, 'papers')
  fs.mkdirSync(libPapers, { recursive: true })
  const outcomes: ImportOutcome[] = []
  for (let i = 0; i < filePaths.length; i++) {
    const src = filePaths[i]
    send('import:progress', { done: i, total: filePaths.length, current: path.basename(src) })
    const fb = titleFromFilename(src)
    let title = fb.base
    let authors = ''
    let year = fb.year
    let venue = ''
    let categorySlug = 'inbox'
    let paperSlug = slugify(fb.base)
    let classified = false
    try {
      if (s.apiKey) {
        const pages = await extractPages(src)
        const info = await classify(pages.slice(0, 2).join('\n'))
        if (info) {
          title = info.title
          authors = info.authors
          year = info.year ?? year
          venue = info.venue
          categorySlug = info.categorySlug
          paperSlug = info.paperSlug ? slugify(info.paperSlug) : slugify(`${year ?? ''}-${info.title}`)
          classified = true
        }
      }
      // 目标文件夹：已有分类复用，新分类建 NN-slug
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
      outcomes.push({ file: path.basename(src), ok: true, slug, category: path.basename(dir), classified })
    } catch (err) {
      outcomes.push({ file: path.basename(src), ok: false, classified: false, error: String(err) })
    }
  }
  send('import:progress', { done: filePaths.length, total: filePaths.length, current: '' })
  scanLibrary(s.libraryPath)
  return outcomes
}

// ---------- AI 重新归类 ----------
function movePaperToCategory(paperId: number, newCategorySlug: string, libPapers: string): { category: string; path: string } | null {
  const db = getDb()
  const p = db.prepare('SELECT id, slug, path, category FROM papers WHERE id=?').get(paperId) as
    | { id: number; slug: string; path: string; category: string }
    | undefined
  if (!p) return null
  let destDir = findCategoryDir(libPapers, newCategorySlug)
  if (!destDir) destDir = nextCategoryDir(libPapers, newCategorySlug)
  const dest = path.join(destDir, p.slug)
  if (path.resolve(dest) === path.resolve(path.dirname(p.path))) {
    return { category: path.basename(destDir), path: p.path }
  }
  fs.mkdirSync(destDir, { recursive: true })
  fs.renameSync(path.dirname(p.path), dest) // 整个论文文件夹搬过去
  const newPath = path.join(dest, 'paper.pdf')
  db.prepare('UPDATE papers SET path=?, category=? WHERE id=?').run(newPath, path.basename(destDir), paperId)
  return { category: path.basename(destDir), path: newPath }
}

async function reclassifyOneInternal(
  paper: { id: number; slug: string; title: string; path: string },
  libPapers: string
): Promise<{ ok: boolean; moved: boolean; category?: string; error?: string }> {
  try {
    const pages = await extractPages(paper.path)
    const info = await classify(pages.slice(0, 2).join('\n'))
    if (!info) return { ok: false, moved: false, error: 'AI 未返回有效归类' }
    const r = movePaperToCategory(paper.id, info.categorySlug, libPapers)
    return { ok: true, moved: !!r, category: r?.category }
  } catch (err) {
    return { ok: false, moved: false, error: String(err) }
  }
}

export async function reclassifyAll(send: (ev: string, p: unknown) => void): Promise<void> {
  const s = getSettings()
  const libPapers = path.join(s.libraryPath, 'papers')
  const db = getDb()
  const all = db.prepare('SELECT id, slug, title, path FROM papers ORDER BY id').all() as Array<{
    id: number
    slug: string
    title: string
    path: string
  }>
  let done = 0
  let moved = 0
  for (const p of all) {
    send('classify:progress', { done, total: all.length, current: p.slug })
    const r = await reclassifyOneInternal(p, libPapers)
    if (r.moved) moved++
    done++
    send('classify:progress', { done, total: all.length, current: p.slug })
  }
  send('classify:progress', { done: all.length, total: all.length, current: '' })
  console.log(`[reclassify] 完成：${moved}/${all.length} 篇被移动`)
}

export async function reclassifyOne(paperId: number, send: (ev: string, p: unknown) => void): Promise<boolean> {
  const s = getSettings()
  const libPapers = path.join(s.libraryPath, 'papers')
  const p = getDb().prepare('SELECT id, slug, title, path FROM papers WHERE id=?').get(paperId) as
    | { id: number; slug: string; title: string; path: string }
    | undefined
  if (!p) return false
  const r = await reclassifyOneInternal(p, libPapers)
  send('classify:progress', { done: 1, total: 1, current: '' })
  return r.ok && !!r.moved
}
