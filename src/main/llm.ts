import { getSettings } from './db'
import { httpFetch, isAbortError, netErrorReason } from './http'
import { providerKindOf, isKimiCodeEndpoint, kimiCodeHint, type ProviderKind } from '../shared/providers'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// 连接测试 / 设置页直测用的端点覆盖：不落盘、直接用界面当前编辑值测试
export interface LlmEndpoint {
  apiBase?: string
  apiKey?: string
  model?: string
  provider?: string
}

// 一次请求实际发往哪里。服务商类型以 API Base 判定——请求发到哪家就按哪家的方言适配参数
//（配置里记的 provider 可能与地址对不上，如手动改过地址）
interface Endpoint {
  apiBase: string
  apiKey: string
  model: string
  kind: ProviderKind
}

function resolveEndpoint(over?: LlmEndpoint): Endpoint {
  const s = getSettings()
  const apiBase = over?.apiBase ?? s.apiBase ?? ''
  // Key 与模型名去首尾空白：粘贴 Key 常带回车/空格，带进请求头会被判成无效 Key
  return {
    apiBase: apiBase.trim().replace(/\/+$/, ''),
    apiKey: (over?.apiKey ?? s.apiKey ?? '').trim(),
    model: (over?.model ?? s.model ?? '').trim(),
    kind: providerKindOf(apiBase, over?.provider ?? s.provider)
  }
}

// ---------- 请求体：可选参数按服务商/模型适配 ----------

// 可选参数组。各家、各模型对它们的支持不一（推理模型常拒绝 temperature，非推理模型不认
// 思考参数，非流式可能不支持思考开关……），服务端明确拒绝时按组剥离重试。
// 顺序即剥离顺序：先采样参数，再思考参数——后者是功能开关，尽量保住
const OPT_GROUPS = [
  { name: 'temperature', keys: ['temperature'] },
  { name: 'thinking', keys: ['thinking', 'enable_thinking', 'reasoning_effort'] }
] as const
type OptGroup = (typeof OPT_GROUPS)[number]['name']
// 已确认不支持的组，按「接口 + 模型」记忆在进程内：下次直接不发，不再多打一次被拒的请求
const unsupportedOpts = new Map<string, Set<OptGroup>>()

// Kimi 现役模型的 temperature 是固定值，官方明确「传入其他值会报错」；
// OpenAI 的推理模型（o 系 / gpt-5）同样只接受默认值
function wantsTemperature(kind: ProviderKind, model: string): boolean {
  if (kind === 'moonshot') return false
  if (kind === 'openai' && /^(o\d|gpt-5)/i.test(model)) return false
  return true
}

// 思考开关 → 各服务商参数。只对确认支持的模型下发：旧模型 / 非推理模型收到这些参数多半直接 400。
// 未知的新模型交给下面的「被拒即剥离重试」兜底，不必每次服务商发新模型就改这里
function applyThinking(body: Record<string, unknown>, kind: ProviderKind, model: string, on: boolean, stream: boolean): void {
  if (kind === 'zhipu') {
    // thinking 开关自 GLM-4.5 起提供；glm-4-plus 等上一代模型不认
    if (/^glm-(4\.[5-9]|[5-9])/i.test(model)) body.thinking = { type: on ? 'enabled' : 'disabled' }
  } else if (kind === 'qwen') {
    // 通义商用模型的思考开关只在流式下生效，非流式（连接测试 / 查询改写 / 后校验）传入会被拒
    if (stream) body.enable_thinking = on
  } else if (kind === 'openai') {
    if (/^(o\d|gpt-5)/i.test(model)) body.reasoning_effort = on ? 'medium' : 'low'
  } else if (kind === 'moonshot') {
    // K3 系列始终思考，用顶层 reasoning_effort 调强度（默认 max；阅读问答用 high 足够，低档更快更省）
    if (/^kimi-k3/i.test(model)) body.reasoning_effort = on ? 'high' : 'low'
    // K2.6 可开关；K2.7-code 始终思考不可关，不下发
    else if (/^kimi-k2\.6/i.test(model)) body.thinking = { type: on ? 'enabled' : 'disabled' }
  }
  // deepseek / mimo / custom：无通用思考参数，交给模型自身决定（如 deepseek-reasoner）
}

function buildBody(ep: Endpoint, messages: ChatMessage[], stream: boolean, temperature: number | undefined, drop: Set<OptGroup>): Record<string, unknown> {
  const body: Record<string, unknown> = { model: ep.model, messages, stream }
  if (wantsTemperature(ep.kind, ep.model) && !drop.has('temperature')) body.temperature = temperature ?? 0.3
  if (!drop.has('thinking')) applyThinking(body, ep.kind, ep.model, getSettings().thinkingLevel !== 'off', stream)
  return body
}

// 服务端表示「不认识 / 不支持某个可选参数」的报错特征
const PARAM_REJECTED_RE =
  /temperature|top_p|reasoning_effort|enable_thinking|["']thinking["']|unsupported|unrecognized|unknown (parameter|argument|field|property)|extra_forbidden|not support|only support|参数(非法|错误|不存在)|不支持/i

// 流内错误事件 / HTTP 错误体里的 error 字段（各家形态不一：字符串、对象，或干脆没有 error 外层）
function errorFields(raw: unknown): { message: string; code: string; type: string } {
  const e = typeof raw === 'string' ? { message: raw } : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const msg = String(e.message ?? '').trim()
  const code = String(e.code ?? '').trim()
  const type = String(e.type ?? '').trim()
  return { message: msg, code, type }
}

function isModelGone(f: { message: string; code: string; type: string }): boolean {
  const all = `${f.message} ${f.type} ${f.code}`
  return /model|模型/i.test(f.message) && /not (found|exist)|does not exist|invalid|不存在|已下线|resource_not_found/i.test(all)
}

// 已翻译过的服务商错误：上层不要再包装
class ApiError extends Error {}

// 把服务商的错误翻成一句能照着做的话：原因 + 排查方向，原始报错附在后面便于核对。
// status=0 表示流式响应中途报的错（HTTP 本身是 200，错误藏在数据流里）
function apiError(status: number, f: { message: string; code: string; type: string }, ep: Pick<Endpoint, 'apiBase' | 'model' | 'kind'>): Error {
  const all = `${f.message} ${f.type} ${f.code}`
  const filtered = /content_filter|敏感|risk|safety/i.test(all)
  const tooLong = /context|token|length|too long|maximum|长度/i.test(all)
  let hint = ''
  if (status === 401) {
    hint = 'API Key 无效，或与该 API Base 不匹配'
    // 两站账号、余额、Key 完全独立——拿国内 Key 调国际端点（或反过来）是最常见的 401
    if (ep.kind === 'moonshot') hint += '。Kimi 国内站（api.moonshot.cn）与国际站（api.moonshot.ai）的 Key 不通用，请确认 Key 所属平台与 API Base 一致'
  } else if (status === 402) hint = '账户余额不足或已欠费，请到服务商控制台充值'
  else if (status === 403) {
    hint = /unsupported_country|country.*not support/i.test(all)
      ? '当前网络所在地区不在该服务商的支持范围内：请开启系统代理后重试（应用会跟随系统代理设置）'
      : '没有访问权限：该模型未对当前账号开放，或 IP 不在服务商白名单内'
  } else if (status === 404) {
    hint = isModelGone(f) ? `模型「${ep.model}」不存在或已下线` : '接口地址不存在：请检查 API Base 是否完整（OpenAI 兼容接口一般以 /v1 结尾）'
  } else if (status === 429) hint = '请求过于频繁或额度不足：稍后重试，或检查账户额度'
  else if (status >= 500) hint = `服务商内部错误（${status}），请稍后重试`
  else if (filtered) hint = '请求被服务商的内容安全审查拦截'
  else if (tooLong) hint = '输入超出模型的上下文长度：请缩短内容，或换用长上下文模型'
  else if (isModelGone(f)) hint = `模型「${ep.model}」不存在或已下线`
  else if (status === 400 || status === 422) hint = '请求参数被服务商拒绝'
  else hint = '请求失败'
  if (isModelGone(f)) hint += '。可在 设置 → AI 配置 点「同步模型」获取该服务商当前可用的模型'
  const detail = f.message.replace(/\s+/g, ' ').slice(0, 240)
  const head = status > 0 ? `服务商返回 ${status}` : '服务商中断了响应'
  return new ApiError(`${head}：${hint}${detail && !hint.includes(detail) ? `（${detail}）` : ''}`)
}

// 网络层失败（没拿到 HTTP 响应）：翻成「连不上 + 原因 + 排查方向」
function friendlyFetchError(err: unknown, apiBase: string): Error {
  if (err instanceof ApiError) return err
  if (isAbortError(err)) return err instanceof Error ? err : new Error(String(err))
  return new Error(`无法连接 ${apiBase}：${netErrorReason(err)}。请检查网络与 API Base 地址`)
}

// ---------- 超时：等响应有时限，流式读取有「空闲时限」 ----------
// 挂起的连接不能让界面永远转圈。外部 signal（停止生成）与超时共用一个控制器
function armTimeout(external: AbortSignal | undefined, firstMs: number, idleMs: number) {
  const ac = new AbortController()
  let timedOut = false
  const trip = (): void => {
    timedOut = true
    ac.abort()
  }
  let timer = setTimeout(trip, firstMs)
  const onAbort = (): void => ac.abort()
  external?.addEventListener('abort', onAbort)
  return {
    signal: ac.signal,
    // 收到一段数据就把空闲计时重置
    bump(): void {
      clearTimeout(timer)
      timer = setTimeout(trip, idleMs)
    },
    get timedOut(): boolean {
      return timedOut
    },
    done(): void {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }
}

// 超时时限（毫秒）。导出为可改对象，只为回归脚本能把超时调短来验证「挂起的连接必须明确报错」；运行时不要改
export const LLM_TIMEOUTS = {
  firstByteMs: 90_000, // 首个响应：推理模型排队 + 建连
  idleMs: 120_000, // 流式空闲：思考模型持续吐推理片段，长时间无数据即视为断开
  nonStreamMs: 120_000 // 非流式整次请求（未显式给超时的调用，如连接测试）
}

// 发一次 chat/completions，处理「可选参数被拒 → 剥离重试」。只在拿到 2xx 后才返回，
// 所以重试绝不会重复输出已下发的内容
async function postChat(ep: Endpoint, messages: ChatMessage[], stream: boolean, opts: { temperature?: number; signal?: AbortSignal }): Promise<Response> {
  const url = `${ep.apiBase}/chat/completions`
  const memoryKey = `${ep.apiBase}|${ep.model}`
  const drop = new Set<OptGroup>(unsupportedOpts.get(memoryKey) ?? [])
  for (;;) {
    const body = buildBody(ep, messages, stream, opts.temperature, drop)
    const resp = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal
    })
    if (resp.ok) {
      if (drop.size) unsupportedOpts.set(memoryKey, new Set(drop))
      return resp
    }
    const text = await resp.text().catch(() => '')
    if (resp.status === 400 || resp.status === 422) {
      let rejected = false
      try {
        const j = JSON.parse(text)
        rejected = PARAM_REJECTED_RE.test(String(j?.error?.message ?? j?.error ?? j?.message ?? text))
      } catch {
        rejected = PARAM_REJECTED_RE.test(text)
      }
      if (rejected) {
        // 下一组「本次确实发了、且还没被剥离」的可选参数
        const next = OPT_GROUPS.find((g) => !drop.has(g.name) && g.keys.some((k) => k in body))
        if (next) {
          drop.add(next.name)
          continue
        }
      }
    }
    let fields: { message: string; code: string; type: string }
    try {
      const j = JSON.parse(text)
      fields = errorFields(j?.error ?? j)
    } catch {
      // 非 JSON（网关的 HTML 错误页等）：只留状态码，避免把整页 HTML 甩给用户
      fields = { message: '', code: '', type: '' }
    }
    throw apiError(resp.status, fields, ep)
  }
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c
  // 少数服务商的增量是分段数组 [{type:'text', text}]
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('')
  }
  return ''
}

export interface StreamOpts {
  temperature?: number
  signal?: AbortSignal
  // 推理片段（reasoning_content）：思考模型在正文之前先输出推理过程，实时回传给界面显示「思考中」
  onReason?: (text: string) => void
  // 流结束时的 finish_reason（length / content_filter / stop…），空串表示服务商没给
  onFinish?: (reason: string) => void
}

// SSE 流式调用（signal 供「停止生成」中断请求）。
// 只产出正文增量；流内错误、截断原因不吞掉，由调用方决定怎么提示
export async function* chatStream(messages: ChatMessage[], opts: StreamOpts = {}): AsyncGenerator<string> {
  const ep = resolveEndpoint()
  if (!ep.apiKey) {
    yield '⚠️ 尚未配置 API Key：请点击左上角「设置」，在 AI 配置中填入服务商的 API Key。'
    return
  }
  if (isKimiCodeEndpoint(ep.apiBase)) throw new Error(kimiCodeHint)
  const t = armTimeout(opts.signal, LLM_TIMEOUTS.firstByteMs, LLM_TIMEOUTS.idleMs)
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let finish = ''
  // 解析一行 SSE：取出正文增量；done=true 表示流在此结束（[DONE]）
  const step = (line: string): { text: string; done: boolean } => {
    const raw = line.trim()
    if (!raw.startsWith('data:')) return { text: '', done: false }
    const payload = raw.slice(5).trim()
    if (!payload) return { text: '', done: false }
    if (payload === '[DONE]') return { text: '', done: true }
    let json: any
    try {
      json = JSON.parse(payload)
    } catch {
      return { text: '', done: false } // 心跳 / 半行
    }
    // 200 的流里也可能带错误（并发超限、内容审查、上游故障）：不处理的话回答会无声地截断
    if (json.error) throw apiError(0, errorFields(json.error), ep)
    const choice = json.choices?.[0]
    if (!choice) return { text: '', done: false } // 仅含 usage 的收尾块
    if (choice.finish_reason) finish = String(choice.finish_reason)
    const delta = choice.delta ?? {}
    const reason = delta.reasoning_content ?? delta.reasoning
    if (typeof reason === 'string' && reason) opts.onReason?.(reason)
    return { text: contentText(delta.content), done: false }
  }
  try {
    const resp = await postChat(ep, messages, true, { temperature: opts.temperature, signal: t.signal })
    if (!resp.body) throw new Error('服务商没有返回响应体')
    reader = resp.body.getReader()
    t.bump()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      t.bump()
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const s = step(line)
        if (s.text) yield s.text
        if (s.done) {
          opts.onFinish?.(finish)
          return
        }
      }
    }
    // 流以 EOF 结束：末行可能不带换行
    if (buf) {
      const s = step(buf)
      if (s.text) yield s.text
    }
    opts.onFinish?.(finish)
  } catch (err) {
    if (t.timedOut) {
      throw new Error('等待服务商响应超时：请求已发出但长时间没有返回。请检查网络 / 代理，或稍后重试')
    }
    throw friendlyFetchError(err, ep.apiBase)
  } finally {
    t.done()
    // 提前退出（停止生成、[DONE] 之后连接未关）时断开连接，不让请求在后台挂着
    if (reader) void reader.cancel().catch(() => {})
  }
}

// 流结束原因 → 追加到回答末尾的提示（空串 = 正常结束，不用提示）。
// 被截断、被审查拦截、一个字没答，都不能无声吞掉——用户看到的只会是半截话或空气泡，
// 分不清是模型的问题还是「没接上」
export function finishNote(finish: string, answer: string): string {
  const filtered = /filter|sensitive|inspection|block/i.test(finish)
  const truncated = finish === 'length' || finish === 'max_tokens'
  if (!answer.trim()) {
    if (filtered) return '⚠️ 模型没有返回内容：本次回答被服务商的内容审查拦截。'
    if (truncated) return '⚠️ 模型没有返回内容：思考过程耗尽了输出长度上限，请重试，或关闭思考开关。'
    return '⚠️ 模型返回了空内容：可能触发了内容审查或服务异常，请重试或更换模型。'
  }
  if (filtered) return '\n\n> ⚠️ 回答到此被服务商的内容审查中断。'
  if (truncated) return '\n\n> ⚠️ 回答达到输出长度上限，后续内容被截断。'
  return ''
}

// 笔记整理：把读者在论文上留下的批注与笔记交给模型归纳成结构化的阅读笔记（不检索、不带引用编号）
export function notesMessages(title: string, items: Array<{ page: number | null; quote?: string; note?: string }>): ChatMessage[] {
  const body = items
    .map((it) =>
      it.quote !== undefined
        ? `【第 ${it.page} 页 · 批注】原文：「${it.quote.slice(0, 600)}」${it.note ? `\n批注：${it.note}` : '（未写批注）'}`
        : `【${it.page != null ? `第 ${it.page} 页` : '全文'} · 笔记】${it.note ?? ''}`
    )
    .join('\n\n')
  return [
    {
      role: 'system',
      content:
        `你是科研阅读助手。下面是读者在论文《${title}》上留下的批注与笔记。请整理成一份结构化的阅读笔记，` +
        '用中文、markdown 小标题加要点：1）读者关注的核心问题与主线思路；' +
        '2）按主题归并的要点，保留读者原话里的术语与判断，并注明所在页码；' +
        '3）批注之间的联系、补充或前后矛盾之处；4）读者的疑问与可以继续追问、跟进的方向。' +
        '只依据给定内容归纳，不替读者补充论文里的事实，不评价读者观点的对错。'
    },
    { role: 'user', content: body }
  ]
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

// 从模型输出里抠出 JSON 对象：容忍 ```json 围栏、前后寒暄文字。
// 查询改写 / 后校验 / 导入识别都要求模型「只输出 JSON」，但各家模型守不守规矩并不一致
export function parseJsonLoose<T extends object = Record<string, unknown>>(text: string): T | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  const candidates = first >= 0 && last > first ? [stripped.slice(first, last + 1), stripped] : [stripped]
  for (const c of candidates) {
    try {
      const v = JSON.parse(c)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as T
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

export interface ChatOnceResult {
  latencyMs: number
  reply: string
}

// 非流式一次性调用（连接测试/查询改写/后校验用）；over 提供时用界面当前编辑值直测；
// timeoutMs 供检索链路上的短等场景（改写 4s / 校验 15s），超时抛 Error('timeout') 由调用方回退
export async function chatOnce(messages: ChatMessage[], over?: LlmEndpoint, timeoutMs: number = LLM_TIMEOUTS.nonStreamMs): Promise<ChatOnceResult> {
  const ep = resolveEndpoint(over)
  if (!ep.apiBase) throw new Error('未配置 API Base')
  if (!ep.apiKey) throw new Error('未配置 API Key')
  if (!ep.model) throw new Error('未配置模型名')
  if (isKimiCodeEndpoint(ep.apiBase)) throw new Error(kimiCodeHint)
  const t0 = Date.now()
  const t = armTimeout(undefined, timeoutMs, timeoutMs)
  try {
    const resp = await postChat(ep, messages, false, { signal: t.signal })
    t.bump()
    const json = (await resp.json()) as { choices?: Array<{ message?: { content?: unknown } }>; error?: unknown }
    if (json.error) throw apiError(200, errorFields(json.error), ep)
    const reply = contentText(json.choices?.[0]?.message?.content)
    if (!reply.trim()) throw new Error('服务商返回了空内容：模型可能只输出了思考过程（推理额度用尽）或触发了内容审查，请重试或更换模型')
    return { latencyMs: Date.now() - t0, reply }
  } catch (err) {
    // 超时要说人话：连接测试走的就是这条路，报错会原样显示在设置页
    if (t.timedOut || isAbortError(err)) throw new Error('等待服务商响应超时：请检查网络 / 代理，或稍后重试')
    throw friendlyFetchError(err, ep.apiBase)
  } finally {
    t.done()
  }
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
  const ep = resolveEndpoint(over)
  if (!ep.apiKey) return { ok: false, error: '未配置 API Key' }
  if (!ep.apiBase) return { ok: false, error: '未配置 API Base' }
  if (!ep.model) return { ok: false, error: '未配置模型名' }
  try {
    const { latencyMs } = await chatOnce([{ role: 'user', content: 'hi' }], ep)
    let balance: { amount: string; currency: string } | null = null
    try {
      if (ep.kind === 'deepseek') {
        const root = ep.apiBase.replace(/\/v1\/?$/, '')
        const r = await httpFetch(`${root}/user/balance`, { headers: { Authorization: `Bearer ${ep.apiKey}` }, signal: AbortSignal.timeout(10_000) })
        if (r.ok) {
          const j = (await r.json()) as { balance_infos?: Array<{ total_balance: string; currency: string }> }
          const b = j.balance_infos?.[0]
          if (b) balance = { amount: b.total_balance, currency: b.currency }
        }
      }
    } catch {
      balance = null
    }
    return { ok: true, model: ep.model, latencyMs, balance }
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 400) }
  }
}

export type ListModelsResult = { ok: true; models: string[] } | { ok: false; error: string }

// 向服务商拉取可用模型列表（OpenAI 兼容的 GET /models）：预设里的模型名会过期，
// 以服务商实时返回的为准。不是每家都提供这个接口，失败时提示手动填写
export async function listModels(over?: LlmEndpoint): Promise<ListModelsResult> {
  const ep = resolveEndpoint(over)
  if (!ep.apiKey) return { ok: false, error: '未配置 API Key' }
  if (!ep.apiBase) return { ok: false, error: '未配置 API Base' }
  if (isKimiCodeEndpoint(ep.apiBase)) return { ok: false, error: kimiCodeHint }
  const t = armTimeout(undefined, 15_000, 15_000)
  try {
    const r = await httpFetch(`${ep.apiBase}/models`, { headers: { Authorization: `Bearer ${ep.apiKey}` }, signal: t.signal })
    if (r.status === 404 || r.status === 405) return { ok: false, error: '该服务商不提供模型列表接口，请手动填写模型名' }
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      let fields = { message: '', code: '', type: '' }
      try {
        const j = JSON.parse(text)
        fields = errorFields(j?.error ?? j)
      } catch {
        /* 非 JSON 错误体 */
      }
      throw apiError(r.status, fields, ep)
    }
    const j = (await r.json()) as { data?: Array<{ id?: unknown }> }
    const ids = (Array.isArray(j.data) ? j.data : []).map((m) => m?.id).filter((x): x is string => typeof x === 'string' && !!x)
    if (!ids.length) return { ok: false, error: '服务商没有返回任何模型' }
    return { ok: true, models: [...new Set(ids)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) }
  } catch (err) {
    if (t.timedOut) return { ok: false, error: '请求超时：请检查网络与 API Base 地址' }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    t.done()
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
