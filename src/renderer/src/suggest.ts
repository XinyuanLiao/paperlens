import type { Paper } from './types'

// 根据库内实际内容（标题关键词 / 分类分布 / 近期文献）实时生成建议问题——
// 本地推导，不调 LLM：无延迟、无费用、无 API key 依赖，库一变建议就跟着变

const STOP = new Set([
  'the', 'and', 'for', 'are', 'with', 'this', 'that', 'from', 'have', 'has', 'was', 'were', 'will',
  'can', 'its', 'their', 'than', 'then', 'when', 'what', 'which', 'how', 'why', 'does', 'not', 'but',
  'all', 'any', 'into', 'over', 'between', 'based', 'using', 'used', 'via', 'about', 'toward',
  'towards', 'new', 'novel', 'study', 'review', 'first', 'second', 'third', 'part', 'under', 'within',
  'application', 'applications', 'approach', 'method', 'methods', 'analysis', 'design', 'research'
])

// 标题词的文档频率（每篇只计一次），取跨论文复现最多的实词作为研究方向关键词
function topKeywords(papers: Paper[], k: number): string[] {
  const df = new Map<string, number>()
  for (const p of papers) {
    const seen = new Set<string>()
    for (const w of p.title.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? []) {
      const t = w.toLowerCase()
      if (STOP.has(t) || seen.has(t)) continue
      seen.add(t)
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const sorted = [...df.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const strong = sorted.filter(([, n]) => n >= 2).map(([w]) => w)
  if (strong.length >= k) return strong.slice(0, k)
  // 小库：df>=2 不够时，用最长的高频词补齐（长词更具体）
  return sorted
    .slice(0, Math.max(k * 4, 12))
    .sort((a, b) => b[0].length - a[0].length)
    .slice(0, k)
    .map(([w]) => w)
}

export function buildSuggestions(papers: Paper[], catCounts: Map<string, number>): string[] {
  if (papers.length === 0) {
    return ['这个文献库里有哪些研究方向？', '帮我梳理库中所有论文的方法脉络']
  }
  const kw = topKeywords(papers, 6)
  const cats = [...catCounts.entries()]
    .filter(([c]) => c !== 'inbox' && c !== '未分类')
    .sort((a, b) => b[1] - a[1])
  const pool: string[] = []

  if (kw[0]) pool.push(`梳理库内关于「${kw[0]}」的研究脉络与代表论文`)
  if (kw[0] && kw[1]) pool.push(`对比「${kw[0]}」与「${kw[1]}」两类方法的异同与适用场景`)
  else if (kw[0]) pool.push(`库内关于「${kw[0]}」有哪些不同的技术路线？`)
  if (cats.length && cats[0][1] >= 2) pool.push(`「${cats[0][0]}」分类下的 ${cats[0][1]} 篇文献主要覆盖哪些方向？`)

  // 近期加入的论文里稳定挑一篇（有区分度但不随机跳动）
  const byAdded = [...papers].sort((a, b) => (b.added_at ?? '').localeCompare(a.added_at ?? ''))
  const pick = byAdded[Math.min(byAdded.length - 1, 1 + (papers.length % 3))]
  if (pick?.title) pool.push(`《${pick.title.slice(0, 50)}》的核心方法与结论是什么？`)

  pool.push('这个文献库里有哪些研究方向？')
  return pool.slice(0, 4)
}
