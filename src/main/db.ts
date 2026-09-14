import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

export interface Paper {
  id: number
  slug: string
  title: string
  authors: string
  year: number | null
  venue: string
  category: string
  path: string
  status: string
  n_pages: number
  indexed: number
  added_at: string
  opened_at?: string | null
}

export type Theme = 'system' | 'light' | 'dark'

// 多服务商配置（与渲染端 types.ts 的 ProviderProfile 保持一致）
export interface ProviderProfile {
  provider: string
  apiBase: string
  apiKey: string
  models: string[]
}

export interface Settings {
  libraryPath: string
  apiBase: string
  apiKey: string
  model: string
  provider: string
  embedProvider: 'local' | 'zhipu' | 'ollama'
  ollamaUrl: string
  ollamaEmbedModel: string
  translateTarget: string
  theme: Theme
  setupDone: boolean
  models: string[]
  thinkingLevel: 'default' | 'off' | 'low' | 'medium' | 'high'
  profiles?: ProviderProfile[]
}

// 默认文献库：跟随平台放到「文档」目录（开发态 app 未 ready 前不能调 getPath，惰性求值）
let defaultLibraryPath: string | null = null
export function defaultLibrary(): string {
  if (!defaultLibraryPath) defaultLibraryPath = path.join(app.getPath('documents'), 'PaperLens')
  return defaultLibraryPath
}

const DEFAULTS: Settings = {
  libraryPath: '', // 由 initDb 填充（依赖 app ready）
  apiBase: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4.5-air',
  provider: 'zhipu',
  embedProvider: 'local',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaEmbedModel: 'bge-m3',
  translateTarget: '中文',
  theme: 'system',
  setupDone: false,
  models: [],
  thinkingLevel: 'default'
}

let db: Database.Database

export function initDb(): void {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  db = new Database(path.join(dir, 'paperlens.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE, title TEXT, authors TEXT DEFAULT '',
      year INTEGER, venue TEXT DEFAULT '', category TEXT DEFAULT '',
      path TEXT UNIQUE, status TEXT DEFAULT 'unread',
      n_pages INTEGER DEFAULT 0, indexed INTEGER DEFAULT 0,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chunks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER REFERENCES papers(id) ON DELETE CASCADE,
      page INTEGER, ord INTEGER, text TEXT, vec BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, paper_id UNINDEXED, page UNINDEXED, tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS highlights(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER REFERENCES papers(id) ON DELETE CASCADE,
      page INTEGER, rects TEXT, text TEXT DEFAULT '',
      color TEXT DEFAULT 'yellow',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hl_paper ON highlights(paper_id);
  `)
  // 迁移：papers 增加 pvec（整篇级向量：标题+作者+首页）与 opened_at（最近打开时间）
  const cols = (db.prepare('PRAGMA table_info(papers)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!cols.includes('pvec')) db.exec('ALTER TABLE papers ADD COLUMN pvec BLOB')
  if (!cols.includes('opened_at')) db.exec('ALTER TABLE papers ADD COLUMN opened_at TEXT')
  // 整篇级全文索引：标题/作者/出处可被 BM25 直接命中（块索引只含正文，标题查不到）
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
    title, authors, venue, slug, tokenize='trigram'
  );`)
  // 清理孤儿块（外键级联默认关闭，删除论文行后块会残留）
  db.exec('DELETE FROM chunks WHERE paper_id NOT IN (SELECT id FROM papers)')
  db.exec('DELETE FROM chunks_fts WHERE paper_id NOT IN (SELECT id FROM papers)')
  db.exec('DELETE FROM papers_fts WHERE rowid NOT IN (SELECT id FROM papers)')

  const st = db.prepare("SELECT value FROM meta WHERE key='settings'")
  if (!st.get()) {
    db.prepare("INSERT INTO meta(key,value) VALUES('settings',?)").run(
      JSON.stringify({ ...DEFAULTS, libraryPath: defaultLibrary() })
    )
  } else {
    // 迁移：旧版本写死的 macOS 路径在 Windows 上必然失效。
    // 优先探测同名库目录在 Windows 的常见位置（iCloud for Windows 同步盘），保住已扫描的文献。
    const s = getSettings()
    if (s.libraryPath.startsWith('/Users/') && !fs.existsSync(s.libraryPath)) {
      const home = app.getPath('home')
      const lastSeg = s.libraryPath.split('/').filter(Boolean).pop() ?? 'Library'
      const candidates = [path.join(home, 'iCloudDrive', lastSeg), path.join(home, lastSeg)]
      const moved = candidates.find((c) => fs.existsSync(c)) ?? defaultLibrary()
      db.prepare("UPDATE meta SET value=? WHERE key='settings'").run(JSON.stringify({ ...s, libraryPath: moved }))
    }
  }
}

export function getSettings(): Settings {
  const row = db.prepare("SELECT value FROM meta WHERE key='settings'").get() as { value: string }
  return { ...DEFAULTS, ...JSON.parse(row.value) }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  db.prepare("UPDATE meta SET value=? WHERE key='settings'").run(JSON.stringify(next))
  return next
}

export function getMeta(key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined
  return r ? r.value : null
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}

export function getDb(): Database.Database {
  return db
}

// ---------- 库扫描：papers/<分类>/<slug>/paper.pdf + <slug>.md ----------
function parseNote(mdPath: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const raw = fs.readFileSync(mdPath, 'utf8')
    const fm = raw.match(/^---\n([\s\S]*?)\n---/)
    if (fm) {
      const lines = fm[1].split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\w[\w-]*):\s*(.*)$/)
        if (m) {
          let v = m[2].trim()
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
          else if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).replace(/["']/g, '')
          // 多行字符串（如 title: | 或换行引号）拼后续行
          if (v === '|' || v === '>') {
            const parts: string[] = []
            while (i + 1 < lines.length && /^\s{2,}/.test(lines[i + 1])) parts.push(lines[++i].trim())
            v = parts.join(' ')
          }
          out[m[1]] = v
        }
      }
    }
    const h1 = raw.match(/^# (.+)$/m)
    if (h1 && !out.title) out.title = h1[1].trim()
  } catch {
    /* md 缺失就只用文件夹名 */
  }
  return out
}

export interface ScanResult {
  added: number
  updated: number
  total: number
}

export function scanLibrary(libPath: string): ScanResult {
  const res: ScanResult = { added: 0, updated: 0, total: 0 }
  if (!fs.existsSync(libPath)) return res
  const papersDir = path.join(libPath, 'papers')
  const roots = fs.existsSync(papersDir) ? [papersDir] : [libPath]
  const upsert = db.prepare(`
    INSERT INTO papers(slug,title,authors,year,venue,category,path)
    VALUES(@slug,@title,@authors,@year,@venue,@category,@path)
    ON CONFLICT(path) DO UPDATE SET
      slug=excluded.slug, title=excluded.title, authors=excluded.authors,
      year=excluded.year, venue=excluded.venue, category=excluded.category
  `)
  const exists = db.prepare('SELECT id FROM papers WHERE path=?')
  const slugOwner = db.prepare('SELECT id, path FROM papers WHERE slug=?')
  const alignPath = db.prepare('UPDATE papers SET path=? WHERE id=?')
  // 同一文件判定：resolve 归一化分隔符；Windows 再忽略大小写（iCloud 同步可能改写盘符/大小写）
  const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
  // slug 全库唯一：同一 slug 出现在不同路径（重复导入/移动残留）时自动加后缀，避免整个扫描崩溃
  const uniqueSlug = (slug: string, pdf: string): string => {
    const row = slugOwner.get(slug) as { id: number; path: string } | undefined
    if (!row) return slug
    if (samePath(row.path, pdf)) {
      // 指向同一文件但字符串不一致（分隔符/大小写差异）：先把行路径对齐成扫描值，
      // 让 upsert 走 ON CONFLICT(path) 更新，而不是 INSERT 撞 slug 唯一约束
      if (row.path !== pdf) alignPath.run(pdf, row.id)
      return slug
    }
    for (let n = 2; ; n++) {
      const cand = `${slug}-${n}`
      const r2 = slugOwner.get(cand) as { id: number; path: string } | undefined
      if (!r2) return cand
      if (samePath(r2.path, pdf)) {
        if (r2.path !== pdf) alignPath.run(pdf, r2.id)
        return cand
      }
    }
  }
  const upsertOne = (params: Record<string, unknown>, pdf: string): void => {
    try {
      // 先判存在再 upsert：新路径算「新增」，已有路径算「更新」（重扫描据此通知界面刷新）
      const existed = !!exists.get(pdf)
      upsert.run(params)
      if (existed) res.updated++
      else res.added++
      res.total++
    } catch (err) {
      // 单条失败（如并发改写导致约束冲突）不拖垮整个扫描与后续清理
      console.error(`[scan] ${String(params.slug)} 入库失败:`, err)
    }
  }
  for (const root of roots) {
    // 根目录平铺的 PDF 也收进库（category 用根目录名），适配"直接指向一摞论文"的用法
    for (const f of fs.readdirSync(root)) {
      if (!f.toLowerCase().endsWith('.pdf')) continue
      const pdf = path.join(root, f)
      if (!fs.statSync(pdf).isFile()) continue
      const slug = f.slice(0, -4)
      const note = parseNote(path.join(root, `${slug}.md`))
      const year = parseInt(note.year || slug.slice(0, 4), 10) || null
      const dtitle = note.title || slug.replace(/^\d{4}-/, '').replace(/-\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      upsertOne(
        {
          slug: uniqueSlug(slug, pdf),
          title: dtitle,
          authors: note.authors || '',
          year,
          venue: note.venue || '',
          category: path.basename(root) || 'inbox',
          path: pdf
        },
        pdf
      )
    }
    for (const cat of fs.readdirSync(root)) {
      const catDir = path.join(root, cat)
      if (!fs.statSync(catDir).isDirectory() || cat.startsWith('.')) continue
      for (const slug of fs.readdirSync(catDir)) {
        const d = path.join(catDir, slug)
        if (!fs.statSync(d).isDirectory() || slug.startsWith('.')) continue
        let pdf = path.join(d, 'paper.pdf')
        if (!fs.existsSync(pdf)) {
          const any = fs.readdirSync(d).find((f) => f.toLowerCase().endsWith('.pdf'))
          if (!any) continue
          pdf = path.join(d, any)
        }
        const note = parseNote(path.join(d, `${slug}.md`))
        const year = parseInt(note.year || slug.slice(0, 4), 10) || null
        const dtitle = note.title || slug.replace(/^\d{4}-/, '').replace(/-\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        upsertOne(
          {
            slug: uniqueSlug(slug, pdf),
            title: dtitle,
            authors: note.authors || '',
            year,
            venue: note.venue || '',
            category: cat.replace(/^\d+-/, ''),
            path: pdf
          },
          pdf
        )
      }
    }
  }
  // 清掉磁盘上已不存在的论文行：目录改名/手动移动后，旧路径行不清理的话
  // 列表会新旧并存“翻倍”，且新行 indexed=0 会触发整批重新嵌入。
  // 按论文文件夹（slug 目录）判断存在性——iCloud/网盘占位文件只占文件本身，
  // 目录结构始终物化，不会误删未同步条目
  const stale = db.prepare('SELECT id, path FROM papers').all() as Array<{ id: number; path: string }>
  const delRow = db.prepare('DELETE FROM papers WHERE id=?')
  for (const row of stale) {
    try {
      if (!fs.existsSync(path.dirname(row.path))) delRow.run(row.id)
    } catch {
      /* 单行 stat 失败保守跳过 */
    }
  }
  return res
}

export function listPapers(): Paper[] {
  return db.prepare('SELECT * FROM papers ORDER BY category, year, slug').all() as unknown as Paper[]
}

export function setStatus(id: number, status: string): void {
  db.prepare('UPDATE papers SET status=? WHERE id=?').run(status, id)
}

export function markOpened(id: number): void {
  db.prepare("UPDATE papers SET opened_at=datetime('now') WHERE id=?").run(id)
}

// ---------- 分类（目录）名集合：论文行已有的 + 手动新建的空分类 ----------
// 空分类目录里没有论文，扫描发现不了，单独存在 meta 里让侧栏/移动菜单可见
export function getExtraCats(): string[] {
  const r = db.prepare("SELECT value FROM meta WHERE key='extra_cats'").get() as { value: string } | undefined
  if (!r) return []
  try {
    const v = JSON.parse(r.value)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function setExtraCats(cats: string[]): void {
  db.prepare("INSERT INTO meta(key,value) VALUES('extra_cats',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    JSON.stringify([...new Set(cats)])
  )
}

export function listCategoryNames(): string[] {
  const fromPapers = (db.prepare("SELECT DISTINCT category FROM papers WHERE category<>''").all() as Array<{ category: string }>).map(
    (r) => r.category
  )
  return [...new Set([...fromPapers, ...getExtraCats()])].sort((a, b) => a.localeCompare(b))
}
