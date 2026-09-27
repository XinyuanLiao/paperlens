// 库内元信息回填：对出处（venue）缺失的论文做学术检索（CrossRef 主路 + S2 兜底），
// 命中且标题足够相似才把 期刊/作者/年份 写回——显示「待核实」的根源是导入时 venue 缺失
// 且此后无人补填。笔记 frontmatter 是扫描时元数据的权威来源（每次扫描都会用它覆盖 DB），
// 所以必须连同笔记文件一起改，只写 DB 下次扫描就会被空字段打回原形。
//
// 触发：启动/扫描/导入后自动排队（单飞），文件菜单可手动强制重试；失败条目记入
// meta 表的尝试时间戳，7 天内不重复打扰学术 API，礼貌池 ≈1 rps 节流。

import fs from 'node:fs'
import path from 'node:path'
import * as dbmod from './db'
import { lookupBibMeta, diceBigram } from './refmeta'

export interface BibFills {
  venue?: string
  authors?: string
  year?: number
}

// 标题相似门槛：回填写错元数据比留着「待核实」更糟，比被引数查询（0.4）严得多；
// 已知年份与命中年份差 2 年以上同样视为错配拒绝
const DICE_MIN = 0.6
const RETRY_AFTER_MS = 7 * 24 * 3600 * 1000
const GAP_MS = 1200
const TRIED_KEY = 'enrichTried'

type Sender = (ev: string, p: unknown) => void

// 用当前题目查学术库，只回填缺失字段（绝不覆盖已有值），无把握命中返回 null
export async function bibFillsFor(
  title: string,
  cur: { venue: string; authors: string; year: number | null }
): Promise<BibFills | null> {
  const meta = await lookupBibMeta(title)
  if (!meta) return null
  if (diceBigram(meta.title.toLowerCase(), title.toLowerCase()) < DICE_MIN) return null
  if (cur.year != null && meta.year != null && Math.abs(meta.year - cur.year) > 2) return null
  const fills: BibFills = {}
  // venue 黑名单：标题对得上但 container-title 是聚合服务名（蹭名条目漏网时），
  // 填进去比「待核实」误导更甚
  if (!cur.venue && meta.venue && !/faculty opinions|post-publication peer review/i.test(meta.venue))
    fills.venue = meta.venue
  if (!cur.authors && meta.authors) fills.authors = meta.authors
  if (cur.year == null && meta.year != null) fills.year = meta.year
  return Object.keys(fills).length ? fills : null
}

// 把回填结果写进笔记：frontmatter 四个字段统一写成合并后的权威值（扫描按它读回）；
// 动过 venue/year 时正文「**发表:** xxx（待核实）」行一并替换成真实出处。
// 笔记不存在/无 frontmatter（平铺 PDF 等）就生成最小头，扫描照常读回。失败返回 false。
function applyFillsToNote(
  mdPath: string,
  full: { title: string; venue: string; authors: string; year: number | null },
  touched: BibFills
): boolean {
  try {
    let raw = ''
    try {
      raw = fs.readFileSync(mdPath, 'utf8')
    } catch {
      /* 文件不存在按空内容新建 */
    }
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/)
    const q = (s: string): string => s.replace(/"/g, "'")
    if (fm) {
      let block = fm[1]
      const setField = (key: string, val: string): void => {
        const re = new RegExp(`^${key}:.*$`, 'm')
        block = re.test(block) ? block.replace(re, `${key}: "${q(val)}"`) : `${block}\n${key}: "${q(val)}"`
      }
      setField('title', full.title)
      setField('authors', full.authors)
      setField('year', String(full.year ?? 'null'))
      setField('venue', full.venue)
      raw = `---\n${block}\n---${raw.slice(fm[0].length)}`
    } else {
      raw = [
        '---',
        `title: "${q(full.title)}"`,
        `authors: "${q(full.authors)}"`,
        `year: ${full.year ?? 'null'}`,
        `venue: "${q(full.venue)}"`,
        '---',
        '',
        `# ${full.title}`,
        ''
      ].join('\n')
    }
    if (touched.venue || touched.year != null) {
      const line = `- **发表:** ${[full.venue, full.year].filter(Boolean).join(' · ')}`
      if (/^- \*\*发表:\*\* .*$/m.test(raw)) raw = raw.replace(/^- \*\*发表:\*\* .*$/m, line)
    }
    fs.writeFileSync(mdPath, raw)
    return true
  } catch {
    return false
  }
}

// 笔记路径：文件夹版（<slug>/paper.pdf）配 <slug>/<slug>.md；平铺 PDF 配同名 .md。
// 有现成笔记优先用（哪怕在另一个候选位置），没有就按版式默认位置生成
function notePathFor(pdfPath: string): string {
  const dir = path.dirname(pdfPath)
  const cands =
    path.basename(pdfPath).toLowerCase() === 'paper.pdf'
      ? [path.join(dir, `${path.basename(dir)}.md`), pdfPath.replace(/\.[^.]+$/, '.md')]
      : [pdfPath.replace(/\.[^.]+$/, '.md'), path.join(dir, `${path.basename(dir)}.md`)]
  for (const c of cands) if (fs.existsSync(c)) return c
  return cands[0]
}

function applyFills(
  p: { id: number; title: string; authors: string; year: number | null; venue: string; path: string },
  fills: BibFills
): boolean {
  const next = {
    title: p.title,
    venue: fills.venue ?? p.venue,
    authors: fills.authors ?? p.authors,
    year: fills.year ?? p.year
  }
  if (!applyFillsToNote(notePathFor(p.path), next, fills)) return false
  dbmod
    .getDb()
    .prepare('UPDATE papers SET venue=?, authors=?, year=? WHERE id=?')
    .run(next.venue, next.authors, next.year, p.id)
  return true
}

function loadTried(): Record<string, number> {
  try {
    const raw = dbmod.getMeta(TRIED_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function persistTried(tried: Record<string, number>): void {
  try {
    dbmod.setMeta(TRIED_KEY, JSON.stringify(tried))
  } catch {
    /* 记不了尝试时间也只是多查一次，不影响功能 */
  }
}

// 手动触发时清掉尝试记忆：所有缺失条目立即重查一遍
export function clearEnrichTried(): void {
  try {
    dbmod.setMeta(TRIED_KEY, JSON.stringify({}))
  } catch {
    /* ignore */
  }
}

let running = false
let rerun = false

export function isEnrichRunning(): boolean {
  return running
}

// 单飞：任何触发（启动/扫描/导入/手动）只排一个循环；循环期间再触发则结束后补一轮
export function queueEnrich(send: Sender): void {
  if (running) {
    rerun = true
    return
  }
  running = true
  const run = async (): Promise<void> => {
    const db = dbmod.getDb()
    const rows = db
      .prepare(`SELECT id, slug, title, authors, year, venue, path FROM papers WHERE venue='' OR venue IS NULL ORDER BY id DESC`)
      .all() as Array<{ id: number; slug: string; title: string; authors: string; year: number | null; venue: string; path: string }>
    const tried = loadTried()
    const now = Date.now()
    const due = rows.filter((r) => {
      const t = tried[r.slug]
      return !t || now - t > RETRY_AFTER_MS
    })
    const total = due.length
    if (!total) return
    let done = 0
    let fixed = 0
    for (const p of due) {
      tried[p.slug] = Date.now()
      done++
      send('enrich:progress', { phase: 'run', done, total, fixed })
      try {
        const fills = await bibFillsFor(p.title, { venue: p.venue, authors: p.authors, year: p.year })
        if (fills && applyFills(p, fills)) {
          fixed++
          send('papers:changed', { ids: [p.id] }) // 界面立即换上真实出处
          send('enrich:progress', { phase: 'run', done, total, fixed })
        }
      } catch {
        /* 单篇失败不拖垮整轮 */
      }
      persistTried(tried)
      await new Promise((r) => setTimeout(r, GAP_MS))
    }
    send('enrich:progress', { phase: 'done', done, total, fixed })
  }
  void run()
    .catch((e) => console.error('[enrich]', e))
    .finally(() => {
      running = false
      if (rerun) {
        rerun = false
        queueEnrich(send)
      }
    })
}
