import { getSettings } from './db'
import { chatOnce, verifyMessages } from './llm'

// 回答后校验（仅 rag 模式）：规则层（免费、始终）+ LLM 层（默认开，15s 超时回退）。
// 规则层：引用编号存在性、从未被引用的来源、答案提及的论文名不在来源清单。
// LLM 层：引用支持性（张冠李戴/无据可依）、事实（数值/方法名与来源矛盾）、逻辑一致性。

export interface VerifyIssue {
  type: 'citation' | 'fact' | 'logic'
  severity: 'warn' | 'error'
  detail: string
  refs?: number[]
}

export interface VerifyReport {
  level: 'pass' | 'warn' | 'error' | 'skipped'
  ruleCitations: { ok: boolean; missing: number[]; unused: number[] }
  issues: VerifyIssue[]
}

const VERIFY_TIMEOUT_MS = 15_000

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
}

// 规则层：[n] 编号校验 + 《》论文名比对
function ruleCheck(answer: string, sources: Array<{ n: number; title: string }>): { report: Pick<VerifyReport, 'ruleCitations' | 'issues'> } {
  const issues: VerifyIssue[] = []
  const cited = new Set<number>()
  for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) cited.add(parseInt(m[1]))
  const valid = new Set(sources.map((s) => s.n))
  const missing = [...cited].filter((n) => !valid.has(n)).sort((a, b) => a - b)
  const unused = sources.filter((s) => !cited.has(s.n)).map((s) => s.n)
  if (missing.length) {
    issues.push({
      type: 'citation',
      severity: 'error',
      detail: `引用编号 ${missing.map((n) => `[${n}]`).join(' ')} 不在来源清单内（共 ${sources.length} 个来源）`,
      refs: missing
    })
  }
  // 答案中书名号文献必须能在来源标题里对上（防幻觉论文名）
  for (const m of answer.matchAll(/《([^》]{4,80})》/g)) {
    const t = normTitle(m[1])
    if (t.length < 4) continue
    const hit = sources.some((s) => {
      const st = normTitle(s.title)
      return st.includes(t) || t.includes(st)
    })
    if (!hit) {
      issues.push({ type: 'citation', severity: 'warn', detail: `答案提及《${m[1]}》不在本次来源清单中，可能为模型推断` })
    }
  }
  return {
    report: {
      ruleCitations: { ok: missing.length === 0, missing, unused },
      issues
    }
  }
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

export async function verifyAnswer(answer: string, sources: Array<{ n: number; title: string; text: string }>): Promise<VerifyReport> {
  const { report } = ruleCheck(answer, sources.map((s) => ({ n: s.n, title: s.title })))
  const issues = [...report.issues]

  const s = getSettings()
  if (s.answerVerify && s.apiKey) {
    try {
      const { reply } = await Promise.race([
        chatOnce(verifyMessages(answer, sources), undefined, VERIFY_TIMEOUT_MS),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('verify timeout')), VERIFY_TIMEOUT_MS + 1000))
      ])
      const j = parseJsonLoose(reply)
      if (j && Array.isArray(j.issues)) {
        for (const it of j.issues as Array<Record<string, unknown>>) {
          const type = it.type === 'citation' || it.type === 'fact' || it.type === 'logic' ? it.type : null
          if (!type || typeof it.detail !== 'string' || !it.detail.trim()) continue
          issues.push({
            type,
            severity: it.severity === 'error' ? 'error' : 'warn',
            detail: it.detail.trim().slice(0, 200),
            ...(Array.isArray(it.refs) ? { refs: (it.refs as unknown[]).filter((r): r is number => typeof r === 'number') } : {})
          })
        }
      }
    } catch {
      /* 超时/解析失败：规则层结果仍然有效 */
    }
  }

  const hasError = issues.some((i) => i.severity === 'error')
  const level: VerifyReport['level'] = hasError ? 'error' : issues.length ? 'warn' : 'pass'
  return { level, ruleCitations: report.ruleCitations, issues: issues.slice(0, 8) }
}

// 流式被用户中断/空回答时不校验
export function shouldSkipVerify(answer: string, aborted: boolean): boolean {
  return aborted || !answer.trim() || answer.trim().length < 20
}

export function skippedReport(): VerifyReport {
  return { level: 'skipped', ruleCitations: { ok: true, missing: [], unused: [] }, issues: [] }
}
