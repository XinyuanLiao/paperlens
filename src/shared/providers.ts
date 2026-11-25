// 服务商预设表：设置页、首次启动向导、主进程请求体适配共用同一份。
// 预设曾分散复制在多处，改了一处漏另一处——Kimi 的默认模型在两张表里都是早已下线的
// kimi-k2-0711-preview，新用户在向导里配 Kimi 第一步就失败。集中到这里，再无第二份可漂移

export type ProviderKind = 'mimo' | 'zhipu' | 'deepseek' | 'qwen' | 'moonshot' | 'openai' | 'custom'

export interface ProviderPreset {
  // 预设 id（写入配置的 provider 字段；同一服务商可有多个预设，如 Kimi 的国内站/国际站）
  id: string
  // 请求体适配用的服务商类型（参数映射按它走，而非预设 id）
  kind: ProviderKind
  label: string
  base: string
  model: string
  models: string[]
  // 申请 API Key 的控制台地址（界面上的「获取 Key」入口；不确定的留空不显示）
  keyUrl?: string
  // 设置页里该服务商的补充说明
  note?: string
}

// Kimi 现役模型：K3 系列始终思考，用顶层 reasoning_effort 调强度。
// K2.6 / K2.7-code 自 2026-11-01 起停止向新用户开放、预计 12 月底下线，不再列入建议
const KIMI_MODELS = ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3']
const KIMI_NOTE = 'Key 在开放平台按量计费，与 Kimi 会员 / Kimi Code 订阅互不相通。K3 系列始终深度思考，首字会比普通模型慢一些。'

export const PRESETS: ProviderPreset[] = [
  {
    id: 'mimo',
    kind: 'mimo',
    label: '小米 MiMo',
    base: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash',
    models: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6', 'mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-flash', 'mimo-v2-pro']
  },
  {
    id: 'zhipu',
    kind: 'zhipu',
    label: '智谱 GLM',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5-air',
    models: ['glm-4.5-air', 'glm-4.5', 'glm-4-plus'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'deepseek',
    kind: 'deepseek',
    label: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'qwen',
    kind: 'qwen',
    label: '通义千问 Qwen',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey'
  },
  {
    id: 'moonshot',
    kind: 'moonshot',
    label: 'Kimi 月之暗面',
    base: 'https://api.moonshot.cn/v1',
    model: KIMI_MODELS[0],
    models: [...KIMI_MODELS],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: `国内站 Key（platform.moonshot.cn），与国际站账号、余额、Key 完全独立，混用会 401。${KIMI_NOTE}`
  },
  {
    id: 'moonshot-intl',
    kind: 'moonshot',
    label: 'Kimi（国际版）',
    base: 'https://api.moonshot.ai/v1',
    model: KIMI_MODELS[0],
    models: [...KIMI_MODELS],
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    note: `国际站 Key（platform.moonshot.ai），与国内站账号、余额、Key 完全独立，混用会 401。${KIMI_NOTE}`
  },
  {
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    base: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '部分地区需经代理访问；应用会跟随系统代理设置。'
  },
  { id: 'custom', kind: 'custom', label: '自定义 / 其他兼容服务', base: '', model: '', models: [] }
]

// Kimi Code 订阅端点：仅限 Kimi Code CLI / Claude Code 等编程工具调用（按客户端识别），
// 不对第三方应用开放。提前识别并说明，免得用户拿订阅 Key 反复试错
const KIMI_CODE_HOSTS = ['api.kimi.com', 'api.kimi.ai']

// 官方「已下线模型」名单（platform.kimi.com/docs/models）。老配置里若只剩这些，
// 请求必然 404——启动时自动换成现役模型，老用户升级后不用重新配置
const RETIRED_MODELS: Partial<Record<ProviderKind, Set<string>>> = {
  moonshot: new Set([
    'kimi-k2.5',
    'kimi-k2-0905-preview',
    'kimi-k2-0711-preview',
    'kimi-k2-turbo-preview',
    'kimi-k2-thinking',
    'kimi-k2-thinking-turbo',
    'kimi-thinking-preview',
    'kimi-latest',
    'moonshot-v1-8k',
    'moonshot-v1-32k',
    'moonshot-v1-128k',
    'moonshot-v1-auto',
    'moonshot-v1-8k-vision-preview',
    'moonshot-v1-32k-vision-preview',
    'moonshot-v1-128k-vision-preview'
  ])
}

// 地址归一化：去协议、小写、去尾部斜杠，便于前缀比对（兼容用户少写/多写斜杠、大小写不一）
const normBase = (u: string): string => u.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '')
const hostOf = (u: string): string => normBase(u).split('/')[0]

// 由 API Base 反查预设：路径前缀优先（国内站/国际站靠路径与域名共同区分），其次仅域名相同
// （用户填了 https://api.moonshot.cn 而漏掉 /v1 时仍能识别出服务商）
export function guessPreset(apiBase: string): ProviderPreset | undefined {
  const n = normBase(apiBase ?? '')
  if (!n) return undefined
  const byPrefix = PRESETS.filter((p) => p.base && n.startsWith(normBase(p.base))).sort((a, b) => b.base.length - a.base.length)[0]
  if (byPrefix) return byPrefix
  return PRESETS.filter((p) => p.base && hostOf(p.base) === n.split('/')[0]).sort((a, b) => b.base.length - a.base.length)[0]
}

export function guessProvider(apiBase: string): string {
  return guessPreset(apiBase)?.id ?? 'custom'
}

export const providerLabel = (id: string): string => PRESETS.find((p) => p.id === id)?.label ?? id

export const presetById = (id: string): ProviderPreset | undefined => PRESETS.find((p) => p.id === id)

// 服务商类型：以 API Base 为准——请求发往哪里就按哪家的方言适配参数；
// 自定义地址再看配置里记的 provider（用户可能给中转站选了某服务商）
export function providerKindOf(apiBase: string, providerId?: string): ProviderKind {
  const hit = guessPreset(apiBase)
  if (hit) return hit.kind
  return presetById(providerId ?? '')?.kind ?? 'custom'
}

export function isKimiCodeEndpoint(apiBase: string): boolean {
  return KIMI_CODE_HOSTS.includes(hostOf(apiBase))
}

export const kimiCodeHint =
  'api.kimi.com 是 Kimi Code 订阅端点，仅限 Kimi Code CLI、Claude Code 等编程工具调用，不对第三方应用开放。' +
  '请到 platform.moonshot.cn（国内站）或 platform.moonshot.ai（国际站）创建按量计费的 API Key，并把 API Base 换成对应站点的地址。'

export interface RetirableProfile {
  apiBase: string
  models: string[]
}

// 一份模型列表去掉已下线的名字；全是下线模型（典型的老配置）就整份换成现役列表。
// 没有需要改的返回原数组（调用方据此判断是否落库）
function withoutRetired(list: string[] | undefined, apiBase: string): string[] | undefined {
  if (!Array.isArray(list)) return list
  const retired = RETIRED_MODELS[providerKindOf(apiBase)]
  if (!retired) return list
  const kept = list.filter((m) => !retired.has(m))
  return kept.length === list.length ? list : kept.length ? kept : [...(guessPreset(apiBase)?.models ?? [])]
}

// 把配置里已下线的 Kimi 模型换成现役模型。幂等：没有需要改的就原样返回入参，
// 调用方据此判断是否落库。只动名单里的名字，用户自己填的其他模型不碰。
// 新式配置（profiles 多服务商）与老式扁平配置（顶层 apiBase/models）都覆盖
export function migrateRetiredModels<T extends { model: string; apiBase?: string; models?: string[]; profiles?: RetirableProfile[] }>(
  s: T
): T {
  let changed = false
  // 各份列表修好后的样子；老式扁平配置视作一份匿名配置
  const flat: RetirableProfile | undefined = s.profiles?.length ? undefined : { apiBase: s.apiBase ?? '', models: s.models ?? [] }
  const lists: Array<{ apiBase: string; before: string[]; after: string[] }> = []
  for (const p of [...(s.profiles ?? []), ...(flat ? [flat] : [])]) {
    const after = withoutRetired(p.models, p.apiBase) ?? p.models
    if (after !== p.models) changed = true
    lists.push({ apiBase: p.apiBase, before: p.models, after })
  }
  let model = s.model
  if (model && lists.some((l) => l.before.includes(model) && !l.after.includes(model))) {
    const owner = lists.find((l) => l.before.includes(model))!
    const preferred = guessPreset(owner.apiBase)?.model ?? ''
    changed = true
    // 新默认值必须落在修好的列表里：优先该服务商的预设默认，否则列表首项
    model = owner.after.includes(preferred) ? preferred : (owner.after[0] ?? preferred)
  }
  if (!changed) return s
  const next = { ...s, model } as T & { profiles?: RetirableProfile[]; models?: string[] }
  if (s.profiles?.length) next.profiles = s.profiles.map((p, i) => (lists[i].after === p.models ? p : { ...p, models: lists[i].after }))
  else next.models = lists[0]?.after ?? s.models
  return next
}
