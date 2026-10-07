// 批量 BibTeX 导出编排：库级循环 + 结果缓存 + 进度推送 + 写盘前校验。
// 单篇矫正链（official/web/local 三层置信度）在 bibresolve.ts；文本层在 bibtext.ts。
//
// 查询结果按 slug 缓存 7 天（标题变化即失效），重复导出即时完成；
// 单飞 + 1.2s 礼貌间隔（与 enrich.ts 一致），进度经 bib:progress、结果经 bib:result 下发。

import * as dbmod from './db'
import { parseBibtexEntry, renderBibtexEntry, makeCiteKey } from './bibtext'
import { resolvePaperEntry, type BibSource } from './bibresolve'
import type { ParsedEntry } from './bibtext'

export type { BibSource }
export interface BibExportEntry {
  slug: string
  title: string // 库内标题（界面展示与核对基准）
  key: string
  bibtex: string
  source: BibSource
  warnings: string[] // code：unverified / no-venue / no-year / no-authors
}

export interface BibExportResult {
  entries: BibExportEntry[]
  official: number
  web: number
  local: number
}

type Sender = (ev: string, p: unknown) => void

const CACHE_KEY = 'bibExportCache'
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000
const GAP_MS = 1200

interface PaperRow {
  id: number
  slug: string
  title: string
  authors: string
  year: number | null
  venue: string
}

// ---------- 缓存 ----------

interface CacheItem {
  title: string // 存缓存时的库内标题：变了说明笔记改过，缓存作废
  entry: ParsedEntry
  source: BibSource
  warnings: string[]
  ts: number
}

function loadCache(): Record<string, CacheItem> {
  try {
    const raw = dbmod.getMeta(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, CacheItem>) : {}
  } catch {
    return {}
  }
}

function saveCache(cache: Record<string, CacheItem>): void {
  try {
    dbmod.setMeta(CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* 缓存写不进只是下次多查一遍 */
  }
}

// ---------- 编排 ----------

let running = false
let cancelled = false
let lastResult: BibExportResult | null = null
// 循环还在收尾（取消后的 sleep/清理）时来了新请求：排队，收尾完自动补跑一轮。
// 否则「取消后立刻重开对话框」会静默丢失新请求，界面永远停在“正在准备核对…”
let rerunPending = false
let rerunForce = false

export function isBibExportRunning(): boolean {
  return running
}

export function cancelBibExport(): void {
  if (running) cancelled = true
}

export function getLastBibResult(): BibExportResult | null {
  return lastResult
}

function toExportEntries(cache: Record<string, CacheItem>, rows: PaperRow[]): BibExportResult {
  const entries: Array<BibExportEntry & { entry: ParsedEntry }> = []
  for (const p of rows) {
    const c = cache[p.slug]
    if (!c) continue
    entries.push({
      slug: p.slug,
      title: p.title,
      key: c.entry.key,
      bibtex: renderBibtexEntry(c.entry),
      source: c.source,
      warnings: c.warnings,
      entry: c.entry
    })
  }
  // key 去重后重渲染（去重可能改 key，界面预览与最终文件必须同源）
  const seen = new Map<string, number>()
  for (const e of entries) {
    const n = seen.get(e.key) ?? 0
    seen.set(e.key, n + 1)
    if (n > 0) {
      e.key = `${e.key}-${n + 1}`
      e.entry = { ...e.entry, key: e.key }
      e.bibtex = renderBibtexEntry(e.entry)
    }
  }
  return {
    entries: entries.map(({ entry: _entry, ...rest }) => rest),
    official: entries.filter((e) => e.source === 'official').length,
    web: entries.filter((e) => e.source === 'web').length,
    local: entries.filter((e) => e.source === 'local').length
  }
}

// 单飞启动一轮导出核对。force=true 丢弃缓存全部重查（界面「重新联网核对」）。
export function queueBibExport(send: Sender, force = false): void {
  if (running) {
    rerunPending = true
    rerunForce = rerunForce || force
    return
  }
  running = true
  void (async () => {
    const rows = dbmod
      .getDb()
      .prepare('SELECT id, slug, title, authors, year, venue FROM papers ORDER BY category, year, slug')
      .all() as PaperRow[]
    const cache = loadCache()
    const now = Date.now()
    // 待核对：无缓存 / 缓存过期 / 标题变了
    const due = rows.filter((p) => {
      const c = cache[p.slug]
      return force || !c || now - c.ts > CACHE_TTL_MS || c.title !== p.title
    })
    const total = due.length
    send('bib:progress', { phase: 'run', done: 0, total })
    let done = 0
    for (const p of due) {
      if (cancelled) break
      const r = await resolvePaperEntry(p)
      cache[p.slug] = { title: p.title, entry: r.entry, source: r.source, warnings: r.warnings, ts: Date.now() }
      done++
      send('bib:progress', { phase: 'run', done, total })
      saveCache(cache)
      await new Promise((res) => setTimeout(res, GAP_MS))
    }
    const aborted = cancelled && done < total
    send('bib:progress', { phase: 'done', done, total, cancelled: aborted })
    // 用户主动取消：保留上一轮完整核对结果，不下发残缺清单
    if (!aborted) {
      const result = toExportEntries(cache, rows)
      lastResult = result
      send('bib:result', result)
    }
  })()
    .catch((e) => console.error('[bibexport]', e))
    .finally(() => {
      running = false
      cancelled = false
      if (rerunPending) {
        rerunPending = false
        const f = rerunForce
        rerunForce = false
        queueBibExport(send, f)
      }
    })
}

// ---------- 文件组装 + 写盘前校验 ----------

// 校验规则：每条渲染文本必须能被 parseBibtexEntry 完整解析回同 key（往返一致），
// 且全文件 key 唯一。返回错误清单——非空时调用方不得写盘。
export function assembleBibFile(entries: BibExportEntry[]): { content: string; errors: string[] } {
  const errors: string[] = []
  const seen = new Set<string>()
  const parts: string[] = []
  for (const e of entries) {
    const back = parseBibtexEntry(e.bibtex)
    if (!back || back.key !== e.key) {
      errors.push(`${e.title || e.slug}：条目解析失败`)
      continue
    }
    if (seen.has(back.key)) errors.push(`${e.title || e.slug}：引用 key 重复（${back.key}）`)
    seen.add(back.key)
    parts.push(e.bibtex.trimEnd())
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const header = [
    `% PaperLens BibTeX 导出 · ${stamp}`,
    `% 共 ${entries.length} 条 · 官方核对 ${entries.filter((e) => e.source === 'official').length} · 联网核对 ${entries.filter((e) => e.source === 'web').length} · 本地拼装 ${entries.filter((e) => e.source === 'local').length}`,
    ''
  ].join('\n')
  return { content: header + parts.join('\n\n') + '\n', errors }
}
