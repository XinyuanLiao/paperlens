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
  translateTarget: string
  theme: Theme
  fontFamily: string
  setupDone: boolean
  models: string[]
  thinkingLevel: 'off' | 'on'
  profiles?: ProviderProfile[]
  // ---- RAG 管线 ----
  // PDF 解析引擎：marker（Python，结构感知）优先，逐篇失败自动回退内置 pdfjs。
  // markerCmd 留空 = 用自动配置的沙盒环境（markerEnv），填了则优先手动命令
  pdfEngine: 'builtin' | 'marker'
  markerCmd: string
  // 重排序开关（本地 ONNX bge-reranker-v2-m3）：GPU 可用时走完整策略（候选数可配），
  // 仅 CPU 可用时自动轻量化（固定 24 候选直取）
  rerankProvider: 'off' | 'local'
  rerankCandidates: number
  // 查询预处理（术语扩展/意图识别/指代消解）与回答后校验（引用/事实/逻辑）
  queryRewrite: boolean
  answerVerify: boolean
  // 嵌入固定为内置 BAAI/bge-m3（随安装包分发），加速设备自动选择（CUDA/DirectML/GPU→CPU），
  // 均无需设置；旧版本的 embedProvider/ollama*/gpuEnabled 等字段读取时自动忽略
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
  translateTarget: '中文',
  theme: 'system',
  fontFamily: '',
  setupDone: false,
  models: [],
  thinkingLevel: 'on',
  pdfEngine: 'marker',
  markerCmd: '',
  rerankProvider: 'local',
  rerankCandidates: 40,
  queryRewrite: true,
  answerVerify: true
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
      page INTEGER, ord INTEGER, text TEXT, vec BLOB,
      section_no TEXT DEFAULT '', section_title TEXT DEFAULT '', kind TEXT DEFAULT 'body'
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
    CREATE TABLE IF NOT EXISTS chats(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '新对话',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chatmsgs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sources TEXT,
      verify TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chatmsgs ON chatmsgs(chat_id);
  `)
  // 迁移：v4 结构化分块的章节元数据 + 回答校验报告
  const ccols = (db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!ccols.includes('section_no')) db.exec("ALTER TABLE chunks ADD COLUMN section_no TEXT DEFAULT ''")
  if (!ccols.includes('section_title')) db.exec("ALTER TABLE chunks ADD COLUMN section_title TEXT DEFAULT ''")
  if (!ccols.includes('kind')) db.exec("ALTER TABLE chunks ADD COLUMN kind TEXT DEFAULT 'body'")
  const mcols = (db.prepare('PRAGMA table_info(chatmsgs)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!mcols.includes('verify')) db.exec('ALTER TABLE chatmsgs ADD COLUMN verify TEXT')
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

  // v0.1.1 的 chatlog 迁移：global 会话转成一条历史对话（论文问答按新需求不再持久化，直接丢弃）
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chatlog'").get()) {
    const rows = db.prepare("SELECT role, content, sources FROM chatlog WHERE kind='global' ORDER BY id").all() as Array<{
      role: string
      content: string
      sources: string | null
    }>
    if (rows.length) {
      const first = rows.find((r) => r.role === 'user')
      const title = (first?.content ?? '导入的对话').replace(/\s+/g, ' ').slice(0, 24) || '导入的对话'
      const cid = Number(db.prepare('INSERT INTO chats(title) VALUES(?)').run(title).lastInsertRowid)
      const ins = db.prepare('INSERT INTO chatmsgs(chat_id,role,content,sources) VALUES(?,?,?,?)')
      for (const r of rows) ins.run(cid, r.role === 'user' ? 'user' : 'assistant', r.content, r.sources)
    }
    db.exec('DROP TABLE chatlog')
  }

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
  const s = { ...DEFAULTS, ...JSON.parse(row.value) } as Settings & { thinkingLevel?: string }
  // 旧版思考分级（default/low/medium/high）迁移到开/关二态：仅显式 off 才关
  s.thinkingLevel = s.thinkingLevel === 'off' ? 'off' : 'on'
  return s as Settings
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const prev = getSettings()
  // 切换工作区：旧库的手建空分类（extra_cats）不随扫描消失，会残留成打不开的幽灵分类
  if (patch.libraryPath && prev.libraryPath && prev.libraryPath !== patch.libraryPath) {
    setExtraCats([])
  }
  const next = { ...prev, ...patch }
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
  // 清掉不属于当前工作区、或磁盘上已不存在的论文行：
  // ① 目录改名/手动移动后旧行不清理会“翻倍”；② 切换工作区后旧库的行
  // （旧目录在磁盘上仍存在）必须删除，否则两个库的分类/文献会混在一起越积越多。
  // 按论文文件夹（slug 目录）判断存在性——iCloud/网盘占位文件只占文件本身，
  // 目录结构始终物化，不会误删未同步条目
  const root = path.resolve(libPath)
  const rootN = process.platform === 'win32' ? root.toLowerCase() : root
  const underRoot = (p: string): boolean => {
    const a = path.resolve(p)
    const an = process.platform === 'win32' ? a.toLowerCase() : a
    return an === rootN || an.startsWith(rootN + path.sep)
  }
  const stale = db.prepare('SELECT id, path FROM papers').all() as Array<{ id: number; path: string }>
  const delRow = db.prepare('DELETE FROM papers WHERE id=?')
  let removed = 0
  for (const row of stale) {
    try {
      if (!underRoot(row.path) || !fs.existsSync(path.dirname(row.path))) {
        delRow.run(row.id)
        removed++
      }
    } catch {
      /* 单行 stat 失败保守跳过 */
    }
  }
  // 被删论文行留下的块/FTS/整篇索引一并清掉（外键级联默认关闭），
  // 否则切换工作区后旧索引会污染新库的检索
  if (removed > 0) {
    db.exec('DELETE FROM chunks WHERE paper_id NOT IN (SELECT id FROM papers)')
    db.exec('DELETE FROM chunks_fts WHERE paper_id NOT IN (SELECT id FROM papers)')
    db.exec('DELETE FROM papers_fts WHERE rowid NOT IN (SELECT id FROM papers)')
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

// ---------- 对话历史（全库对话按会话持久化；论文问答面板不落库） ----------
export interface ChatMeta {
  id: number
  title: string
  updated_at: string
  n: number
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  sources?: Array<{ n: number; slug: string; title: string; page: number; snippet?: string }>
  // 回答后校验报告（引用/事实/逻辑），仅 rag 模式的 assistant 消息携带
  verify?: unknown
}

export function listChats(): ChatMeta[] {
  return db
    .prepare(
      `SELECT c.id, c.title, c.updated_at, COUNT(m.id) AS n
       FROM chats c LEFT JOIN chatmsgs m ON m.chat_id=c.id
       GROUP BY c.id ORDER BY COALESCE(c.updated_at, c.created_at) DESC, c.id DESC`
    )
    .all() as ChatMeta[]
}

export function loadChat(id: number): ChatMsg[] {
  return (
    db.prepare('SELECT role, content, sources, verify FROM chatmsgs WHERE chat_id=? ORDER BY id').all(id) as Array<{
      role: string
      content: string
      sources: string | null
      verify: string | null
    }>
  ).map((r) => ({
    role: r.role === 'user' ? 'user' : 'assistant',
    content: r.content,
    ...(r.sources ? { sources: JSON.parse(r.sources) } : {}),
    ...(r.verify ? { verify: JSON.parse(r.verify) } : {})
  }))
}

export function createChat(title: string): number {
  const r = db.prepare('INSERT INTO chats(title) VALUES(?)').run(title.slice(0, 60) || '新对话')
  return Number(r.lastInsertRowid)
}

export function appendChatMsg(id: number, role: string, content: string, sources?: string, verify?: string): number {
  const r = db.prepare('INSERT INTO chatmsgs(chat_id,role,content,sources,verify) VALUES(?,?,?,?,?)').run(
    id,
    role === 'user' ? 'user' : 'assistant',
    content,
    sources ?? null,
    verify ?? null
  )
  db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(id)
  return Number(r.lastInsertRowid)
}

export function renameChat(id: number, title: string): void {
  db.prepare('UPDATE chats SET title=? WHERE id=?').run(title.slice(0, 60) || '新对话', id)
}

export function deleteChat(id: number): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM chatmsgs WHERE chat_id=?').run(id)
    db.prepare('DELETE FROM chats WHERE id=?').run(id)
  })
  tx()
}

// 整会话重写（编辑问题重新生成后同步）：单事务清旧插新，updated_at 顺带刷新
export function setChatMessages(
  id: number,
  msgs: Array<{ role: string; content: string; sources?: unknown; verify?: unknown }>
): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM chatmsgs WHERE chat_id=?').run(id)
    const ins = db.prepare('INSERT INTO chatmsgs(chat_id,role,content,sources,verify) VALUES(?,?,?,?,?)')
    for (const m of msgs) {
      if (!m.content?.trim()) continue
      ins.run(
        id,
        m.role === 'user' ? 'user' : 'assistant',
        m.content,
        m.sources ? JSON.stringify(m.sources) : null,
        m.verify ? JSON.stringify(m.verify) : null
      )
    }
    db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(id)
  })
  tx()
}
