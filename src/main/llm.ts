import { getSettings } from './db'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// 思考开关 → 各服务商参数映射；不支持的服务商保持默认（思考行为由模型自身决定）
function applyThinking(body: Record<string, unknown>, provider: string, on: boolean): void {
  if (provider === 'zhipu') {
    body.thinking = { type: on ? 'enabled' : 'disabled' }
  } else if (provider === 'qwen') {
    body.enable_thinking = on
  } else if (provider === 'openai') {
    body.reasoning_effort = on ? 'medium' : 'low'
  }
  // deepseek / moonshot / mimo / custom：无通用思考参数，交给模型选择（如 deepseek-reasoner）
}

function buildBody(model: string, messages: ChatMessage[], stream: boolean, temperature?: number, provider?: string): Record<string, unknown> {
  const s = getSettings()
  const body: Record<string, unknown> = { model, messages, stream, temperature: temperature ?? 0.3 }
  applyThinking(body, provider ?? s.provider, s.thinkingLevel !== 'off')
  return body
}

// 连接测试 / 设置页直测用的端点覆盖：不落盘、直接用界面当前编辑值测试
export interface LlmEndpoint {
  apiBase?: string
  apiKey?: string
  model?: string
  provider?: string
}

function friendlyFetchError(err: unknown, apiBase: string): Error {
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? ''
  return new Error(`无法连接 ${apiBase}${code ? `（${code}）` : ''}：请检查网络与 API Base 地址是否正确`)
}

// 智谱 GLM 等 OpenAI 兼容接口的 SSE 流式调用（signal 供「停止生成」中断请求）
export async function* chatStream(messages: ChatMessage[], opts: { temperature?: number; signal?: AbortSignal } = {}): AsyncGenerator<string> {
  const s = getSettings()
  if (!s.apiKey) {
    yield '⚠️ 尚未配置 API Key：请点击左上角「设置」，在 AI 配置中填入服务商的 API Key。'
    return
  }
  let resp: Response
  try {
    resp = await fetch(`${s.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(buildBody(s.model, messages, true, opts.temperature ?? 0.3)),
      signal: opts.signal
    })
  } catch (err) {
    if (opts.signal?.aborted) throw err
    throw friendlyFetchError(err, s.apiBase)
  }
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

// 非流式一次性调用（连接测试/查询改写/后校验用）；over 提供时用界面当前编辑值直测；
// timeoutMs 供检索链路上的短等场景（改写 4s / 校验 15s），超时抛错由调用方回退
export async function chatOnce(messages: ChatMessage[], over?: LlmEndpoint, timeoutMs?: number): Promise<{ latencyMs: number; reply: string }> {
  const s = getSettings()
  const apiBase = (over?.apiBase ?? s.apiBase ?? '').replace(/\/+$/, '')
  const apiKey = over?.apiKey ?? s.apiKey
  const model = over?.model ?? s.model
  const provider = over?.provider ?? s.provider
  if (!apiBase) throw new Error('未配置 API Base')
  if (!apiKey) throw new Error('未配置 API Key')
  if (!model) throw new Error('未配置模型名')
  const t0 = Date.now()
  let resp: Response
  try {
    resp = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildBody(model, messages, false, undefined, provider)),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    })
  } catch (err) {
    if (timeoutMs && (String(err).includes('Timeout') || String(err).includes('abort'))) throw new Error('timeout')
    throw friendlyFetchError(err, apiBase)
  }
  if (!resp.ok) {
    const txt = (await resp.text().catch(() => '')).slice(0, 180)
    const hint = resp.status === 401 || resp.status === 403 ? '（API Key 无效或无权限）' : resp.status === 404 ? '（检查 API Base 与模型名）' : resp.status === 429 ? '（请求过频或余额不足）' : ''
    throw new Error(`API ${resp.status}${hint}${txt ? `：${txt}` : ''}`)
  }
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

// 连接测试 + 余额查询（DeepSeek 有官方余额接口，其余查不到就返回 null）。
// over = 设置页当前编辑值：先保存再测试的旧逻辑测的是旧全局配置，正确 key 也会失败
export async function testLLM(over?: LlmEndpoint): Promise<TestResult> {
  const s = getSettings()
  const apiBase = (over?.apiBase ?? s.apiBase ?? '').replace(/\/+$/, '')
  const apiKey = over?.apiKey ?? s.apiKey
  const model = over?.model ?? s.model
  const provider = over?.provider ?? s.provider
  if (!apiKey) return { ok: false, error: '未配置 API Key' }
  if (!apiBase) return { ok: false, error: '未配置 API Base' }
  if (!model) return { ok: false, error: '未配置模型名' }
  try {
    const { latencyMs } = await chatOnce([{ role: 'user', content: 'hi' }], { apiBase, apiKey, model, provider })
    let balance: { amount: string; currency: string } | null = null
    try {
      if (provider === 'deepseek') {
        const root = apiBase.replace(/\/v1\/?$/, '')
        const r = await fetch(`${root}/user/balance`, { headers: { Authorization: `Bearer ${apiKey}` } })
        if (r.ok) {
          const j = (await r.json()) as { balance_infos?: Array<{ total_balance: string; currency: string }> }
          const b = j.balance_infos?.[0]
          if (b) balance = { amount: b.total_balance, currency: b.currency }
        }
      }
    } catch {
      balance = null
    }
    return { ok: true, model, latencyMs, balance }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 300) }
  }
}

// 整篇模式：全文按页标记进提示词，引用格式为 [页码]
export function paperFullMessages(
  question: string,
  pages: string[],
  title: string,
  budget = 120000,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  category?: string
): ChatMessage[] {
  const parts: string[] = []
  let used = 0
  let truncated = false
  for (let i = 0; i < pages.length; i++) {
    if (!pages[i].trim()) continue // 参考文献/作者简介等尾部章节裁剪后为空页
    const block = `【第 ${i + 1} 页】
${pages[i]}`
    if (used + block.length > budget) {
      truncated = true
      break
    }
    parts.push(block)
    used += block.length
  }
  const hist: ChatMessage[] = (history ?? [])
    .slice(-4)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }))
  return [
    {
      role: 'system',
      content:
        `你是严谨的学术问答助手。以下是论文《${title}》（分类：${category ?? '未分类'}）的完整正文（按页标记，已省略参考文献与作者简介页）。规则：` +
        '1）仅依据该论文内容回答；2）回答详尽具体，提取方法、实验设置、数值结论等细节，按主题分点组织；' +
        '3）每个关键论断后标注页码引用，格式为 [页码]，如 [5] 表示第 5 页；' +
        '4）论文未覆盖的问题明确说明，不要编造；5）中文回答，专业术语首次出现给英文原文。' +
        (truncated ? '注意：论文过长，仅提供了前部分页面。' : '')
    },
    ...hist,
    { role: 'user', content: `【论文全文】\n${parts.join('\n\n')}\n\n【问题】\n${question}` }
  ]
}

export function ragMessages(
  question: string,
  sources: Array<{ n: number; label: string; text: string }>,
  paperTitle?: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  libStats?: string,
  scopeNote?: string
): ChatMessage[] {
  // n = 论文级编号（同一论文的多个片段共用同一编号），由调用方分派
  const ctx = sources.map((s) => `[${s.n}] ${s.label}\n${s.text}`).join('\n\n')
  // 多轮：带最近两轮问答（ assistant 内容截断，避免上下文膨胀）
  const hist: ChatMessage[] = (history ?? [])
    .slice(-4)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }))
  return [
    {
      role: 'system',
      content:
        '你是严谨的学术问答助手。仅依据提供的文献片段与文献库概况回答问题：' +
        '1）回答要详尽具体：提取片段中的方法名、模型/数据集、实验条件、数值结论等细节，不要只给笼统概括；' +
        '2）结构化输出：按主题分点或使用小标题，适合对比的问题用 markdown 表格呈现；' +
        '3）每个关键论断后紧跟来源编号，如 [1][3]；编号对应「论文」而非片段——同一论文的多个片段共用同一编号，回答中同一论文始终用同一编号，严禁张冠李戴，也不要把引用集中堆在段末；' +
        '片段标注里的 p.页码 与 §章节 是该片段在论文中的位置，说明方法/实验细节出处时可在论断里点明（如「§3.2 的实验设置」）；' +
        '4）不得引入片段与文献库概况之外的论文名称；不同文献观点有差异时明确指出并分别标注来源；' +
        '5）分类归属、各分类篇数、覆盖方向等库级问题以【文献库概况】为准（结合片段内容归纳方向），不要因片段中没有出现分类名就拒绝回答；' +
        '6）片段与概况都不足以回答时明确说"库内文献未覆盖该问题"，不要编造；依据部分覆盖时只回答有据部分并说明缺口；' +
        '7）依据不足但确有必要的推断，句末标注〔不确定〕，不得与有据论断混排；' +
        '8）回答用中文，专业术语首次出现给英文原文。' +
        (paperTitle ? `当前讨论的论文是《${paperTitle}》，优先使用与其相关的片段。` : scopeNote || '当前是跨全库检索模式。')
    },
    ...hist,
    {
      role: 'user',
      content: `【检索到的文献片段】\n${ctx}\n\n${libStats ? `【文献库概况】\n${libStats}\n\n` : ''}【问题】\n${question}`
    }
  ]
}

// 查询改写（检索预处理）：把多轮追问改写成独立问题 + 术语扩展 + 意图判定。
// 只输出 JSON；改写结果仅用于检索，不进入生成
export function rewriteMessages(q: string, history?: Array<{ role: 'user' | 'assistant'; content: string }>): ChatMessage[] {
  const hist = (history ?? [])
    .slice(-4)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 400)}`)
    .join('\n')
  return [
    {
      role: 'system',
      content:
        '你是学术文献库（电力电子与 AI 领域）的检索查询改写器。把用户查询改写为更适合检索的独立问题。判定规则：' +
        'intent="exact" 当查询指向特定术语/缩写/型号/论文名/作者名（需要字面精确匹配）；' +
        'intent="semantic" 当查询是开放式问题（需要语义关联召回）。' +
        'query 字段：改写成独立完整的检索问题——消解"它/这篇/上述方法"等指代、补全缩写全称（如 FM→failure mode），不添加答案性内容；' +
        'keywords 字段：3-8 个检索关键词，英文术语与中文同义词都要有（含缩写与全称）。' +
        '只输出 JSON，格式：{"intent":"exact或semantic","query":"改写后的问题","keywords":["kw1","kw2"]}'
    },
    {
      role: 'user',
      content: `${hist ? `【最近对话（仅供消解指代）】\n${hist}\n\n` : ''}【当前查询】\n${q}`
    }
  ]
}

// 回答后校验：引用支持性 / 事实一致性 / 逻辑一致性三类问题清单。只输出 JSON
export function verifyMessages(answer: string, sources: Array<{ n: number; title: string; text: string }>): ChatMessage[] {
  const ctx = sources
    .map((s) => `[${s.n}] ${s.title}\n${s.text.slice(0, 800)}`)
    .join('\n\n')
    .slice(0, 24000)
  return [
    {
      role: 'system',
      content:
        '你是学术问答的校验员。对照编号来源片段检查回答，找出三类问题：' +
        'citation——引用张冠李戴（论断与所标 [n] 来源内容不符）、论断无任何来源支持、引用了不存在的编号；' +
        'fact——数值、单位、方法名、结论与来源矛盾；' +
        'logic——回答内部前后矛盾。' +
        '只报告真实存在、能指出具体位置的问题，不要吹毛求疵；每条给出中文简述（引用相关编号）。' +
        '只输出 JSON：{"issues":[{"type":"citation或fact或logic","severity":"warn或error","detail":"简述","refs":[n]}]}，无问题输出 {"issues":[]}'
    },
    { role: 'user', content: `【来源片段】\n${ctx}\n\n【待校验回答】\n${answer}` }
  ]
}
