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
}

export type Theme = 'system' | 'light' | 'dark'

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
}

const DEFAULTS: Settings = {
  libraryPath: '/Users/planck/Library/Mobile Documents/com~apple~CloudDocs/Library',
  apiBase: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4.5-air',
  provider: 'zhipu',
  embedProvider: 'local',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaEmbedModel: 'bge-m3',
  translateTarget: '中文',
  theme: 'system'
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
  const st = db.prepare("SELECT value FROM meta WHERE key='settings'")
  if (!st.get()) {
    db.prepare("INSERT INTO meta(key,value) VALUES('settings',?)").run(JSON.stringify(DEFAULTS))
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
  for (const root of roots) {
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
        upsert.run({
          slug,
          title: note.title || slug,
          authors: note.authors || '',
          year,
          venue: note.venue || '',
          category: cat.replace(/^\d+-/, ''),
          path: pdf
        })
        if (exists.get(pdf)) res.updated++
        else res.added++
        res.total++
      }
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
