import { getDb, getSettings } from './db'
import { chatOnce, rewriteMessages } from './llm'

// 查询预处理：术语扩展 + 意图识别（精确匹配 vs 语义关联）+ 多轮指代消解。
// 规则层零成本即时生效；LLM 层（默认开）用当前对话模型改写一次，4s 超时回退规则层。
// 改写结果只用于检索（向量用 query、BM25 用 ftsQuery），生成阶段仍回答用户原话。

export interface PreparedQuery {
  query: string
  ftsQuery: string
  intent: 'exact' | 'semantic'
}

const REWRITE_TIMEOUT_MS = 4000

// 规则层意图判定：引号短语 / 全大写缩写（FM、IGBT）/ 型号数字 / 标题命中 → 精确匹配
function ruleIntent(q: string, titleHit: boolean): 'exact' | 'semantic' {
  if (/["“”][^"“”]{2,}["”]/.test(q)) return 'exact'
  if (/\b[A-Z]{2,}\b/.test(q)) return 'exact'
  if (/\d+(\.\d+)+/.test(q) || /\b\d+[kKmM]?[VAWHz]\b/.test(q)) return 'exact'
  if (titleHit) return 'exact'
  return 'semantic'
}

// papers_fts 标题/作者命中：查询点名了某篇文献
function hitsPaperTitle(q: string): boolean {
  try {
    const r = getDb().prepare(`SELECT rowid FROM papers_fts WHERE papers_fts MATCH ? LIMIT 1`).get(q)
    return !!r
  } catch {
    return false
  }
}

// 规则层关键词：引号短语 + 英文词（≥3 字符），作为 BM25 OR 查询的原料
function ruleKeywords(q: string): string[] {
  const out = new Set<string>()
  for (const m of q.matchAll(/["“”]([^"“”]{2,40})["”]/g)) out.add(m[1].trim())
  for (const m of q.matchAll(/[A-Za-z][A-Za-z0-9-]{2,}/g)) out.add(m[0])
  return [...out].slice(0, 8)
}

// FTS5 MATCH 表达式：多关键词 OR 组合（短语加引号），空则回退原始查询
function buildFtsQuery(keywords: string[], fallback: string): string {
  const kws = keywords
    .map((k) => k.replace(/["\s]+/g, ' ').trim())
    .filter((k) => k.length >= 2)
    .slice(0, 8)
  if (!kws.length) return fallback
  return kws.map((k) => (k.includes(' ') ? `"${k}"` : k)).join(' OR ')
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

export async function preprocessQuery(q: string, history?: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<PreparedQuery> {
  const s = getSettings()
  const trimmed = q.trim()
  if (trimmed.length < 2) return { query: trimmed, ftsQuery: trimmed, intent: 'semantic' }

  const rule = {
    intent: ruleIntent(trimmed, hitsPaperTitle(trimmed)),
    keywords: ruleKeywords(trimmed)
  }

  // LLM 层：改写成独立问题（消解指代）+ 术语扩展（缩写↔全称）+ 意图判定
  if (s.queryRewrite && s.apiKey) {
    try {
      const { reply } = await Promise.race([
        chatOnce(rewriteMessages(trimmed, history), undefined, REWRITE_TIMEOUT_MS),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('rewrite timeout')), REWRITE_TIMEOUT_MS + 500))
      ])
      const j = parseJsonLoose(reply)
      if (j) {
        const intent = j.intent === 'exact' || j.intent === 'semantic' ? j.intent : rule.intent
        const query = typeof j.query === 'string' && j.query.trim() ? j.query.trim() : trimmed
        const kws = Array.isArray(j.keywords)
          ? (j.keywords as unknown[]).filter((k): k is string => typeof k === 'string' && k.trim().length >= 2).map((k) => k.trim())
          : []
        // LLM 关键词与规则关键词合并去重（LLM 在前：术语扩展优先）
        const merged = [...new Set([...kws, ...rule.keywords])]
        return { query, ftsQuery: buildFtsQuery(merged, trimmed), intent }
      }
    } catch {
      /* 超时/解析失败/无网络：回退规则层，不阻塞检索 */
    }
  }
  return { query: trimmed, ftsQuery: buildFtsQuery(rule.keywords, trimmed), intent: rule.intent }
}
