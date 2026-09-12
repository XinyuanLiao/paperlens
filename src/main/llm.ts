import { getSettings } from './db'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ThinkingLevel = 'default' | 'off' | 'low' | 'medium' | 'high'

// 思考等级 → 各服务商参数映射；不支持的服务商保持默认（思考行为由模型自身决定）
function applyThinking(body: Record<string, unknown>, provider: string, level: ThinkingLevel): void {
  if (!level || level === 'default') return
  const off = level === 'off'
  if (provider === 'zhipu') {
    body.thinking = { type: off ? 'disabled' : 'enabled' }
  } else if (provider === 'qwen') {
    body.enable_thinking = !off
    if (!off) body.thinking_budget = level === 'high' ? 38912 : level === 'medium' ? 8192 : 2048
  } else if (provider === 'openai') {
    body.reasoning_effort = level === 'high' ? 'high' : level === 'medium' ? 'medium' : 'low'
  }
  // deepseek / moonshot / custom：无通用思考参数，交给模型选择（如 deepseek-reasoner）
}

function buildBody(model: string, messages: ChatMessage[], stream: boolean, temperature?: number): Record<string, unknown> {
  const s = getSettings()
  const body: Record<string, unknown> = { model, messages, stream, temperature: temperature ?? 0.3 }
  applyThinking(body, s.provider, (s.thinkingLevel ?? 'default') as ThinkingLevel)
  return body
}

// 智谱 GLM 等 OpenAI 兼容接口的 SSE 流式调用
export async function* chatStream(messages: ChatMessage[], opts: { temperature?: number } = {}): AsyncGenerator<string> {
  const s = getSettings()
  if (!s.apiKey) {
    yield '⚠️ 尚未配置 API Key：请点击左下角「设置」，填入智谱开放平台的 API Key。'
    return
  }
  const resp = await fetch(`${s.apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify(buildBody(s.model, messages, true, opts.temperature ?? 0.3))
  })
  if (!resp.ok || !resp.body) {
    throw new Error(`LLM API ${resp.status}: ${await resp.text().catch(() => '')}`)
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta?.content
        if (delta) yield delta as string
      } catch {
        /* 忽略半行/心跳 */
      }
    }
  }
}

export function translateMessages(text: string, context: string, target: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `你是电力电子与 AI 交叉领域的资深学术翻译。将用户给出的文本翻译为${target}，要求：` +
        `1）术语准确（如 bond wire→键合线、junction temperature→结温、DC-link→母线电容、TSEP→热敏电参数）；` +
        `2）保持学术语气与原文逻辑；3）公式、变量名、引用标记保留原样；4）只输出译文。`
    },
    {
      role: 'user',
      content: `【所在页面上下文（仅供理解术语，不要翻译）】\n${context || '（无）'}\n\n【待翻译文本】\n${text}`
    }
  ]
}

export function explainMessages(text: string, context: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是电力电子与 AI 交叉领域的学术助手。用户在论文中选中了一段内容，请解释它：' +
        '先一句话说明它是什么，再展开背景/机理/为什么在这里出现，必要时给出中文术语对照。控制在 200 字内。'
    },
    { role: 'user', content: `【页面上下文】\n${context || '（无）'}\n\n【选中内容】\n${text}` }
  ]
}

// 非流式一次性调用（连接测试用）
export async function chatOnce(messages: ChatMessage[]): Promise<{ latencyMs: number; reply: string }> {
  const s = getSettings()
  const t0 = Date.now()
  const resp = await fetch(`${s.apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify(buildBody(s.model, messages, false))
  })
  if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> }
  return { latencyMs: Date.now() - t0, reply: json.choices?.[0]?.message?.content ?? '' }
}

export interface TestResult {
  ok: boolean
  model?: string
  latencyMs?: number
  balance?: { amount: string; currency: string } | null
  error?: string
}

// 连接测试 + 余额查询（DeepSeek 有官方余额接口，其余查不到就返回 null）
export async function testLLM(): Promise<TestResult> {
  const s = getSettings()
  if (!s.apiKey) return { ok: false, error: '未配置 API Key' }
  try {
    const { latencyMs } = await chatOnce([{ role: 'user', content: 'hi' }])
    let balance: { amount: string; currency: string } | null = null
    try {
      if (s.provider === 'deepseek') {
        const root = s.apiBase.replace(/\/v1\/?$/, '')
        const r = await fetch(`${root}/user/balance`, { headers: { Authorization: `Bearer ${s.apiKey}` } })
        if (r.ok) {
          const j = (await r.json()) as { balance_infos?: Array<{ total_balance: string; currency: string }> }
          const b = j.balance_infos?.[0]
          if (b) balance = { amount: b.total_balance, currency: b.currency }
        }
      }
    } catch {
      balance = null
    }
    return { ok: true, model: s.model, latencyMs, balance }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) }
  }
}

export function ragMessages(question: string, sources: Array<{ label: string; text: string }>, paperTitle?: string): ChatMessage[] {
  const ctx = sources.map((s, i) => `[${i + 1}] ${s.label}\n${s.text}`).join('\n\n')
  return [
    {
      role: 'system',
      content:
        '你是严谨的学术问答助手。仅依据提供的文献片段回答问题：' +
        '1）每个关键论断后标注来源编号，如 [1][3]，编号必须与片段标号一一对应，严禁张冠李戴；2）不得引入片段之外的论文名称；3）片段不足以回答时明确说"库内文献未覆盖该问题"，不要编造；' +
        '4）回答用中文，专业术语首次出现给英文原文。' +
        (paperTitle ? `当前讨论的论文是《${paperTitle}》，优先使用与其相关的片段。` : '当前是跨全库检索模式。')
    },
    { role: 'user', content: `【检索到的文献片段】\n${ctx}\n\n【问题】\n${question}` }
  ]
}
