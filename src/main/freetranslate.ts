// 免费翻译引擎（无需 API Key）：谷歌 gtx 公开接口 + 必应网页版后端。
// 保证未配置 LLM 时划词翻译等基础功能可用；主引擎失败自动切另一家兜底。
// signal 贯穿到每个 fetch：供「停止生成」中断等待中的翻译请求

import { getSettings } from './db'

const TIMEOUT_MS = 12_000

// 设置里的目标语言展示名 → 免费接口的 BCP-47 代码（与 SettingsDialog 的 LANGS 对应）
const LANG_CODE: Record<string, string> = {
  中文: 'zh-CN',
  English: 'en',
  日本語: 'ja',
  한국어: 'ko',
  Français: 'fr',
  Deutsch: 'de',
  Español: 'es',
  Русский: 'ru',
  Português: 'pt',
  Italiano: 'it'
}

function targetCode(target: string): string {
  const t = (target ?? '').trim()
  if (LANG_CODE[t]) return LANG_CODE[t]
  if (/^zh/i.test(t)) return 'zh-CN'
  if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(t)) return t // 已是语言代码则直接用
  return 'zh-CN'
}

// timeout 与外部停止信号合并；signal 缺省时只用超时
const withTimeout = (signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)

// ---------- 谷歌（gtx 公开接口，POST 表单避开 URL 长度限制） ----------

async function googleTranslate(text: string, to: string, signal?: AbortSignal): Promise<string> {
  // 响应 [0] 是逐句 [译文, 原文] 数组
  const body = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: to, dt: 't', ie: 'UTF-8', oe: 'UTF-8', q: text })
  const r = await fetch('https://translate.googleapis.com/translate_a/single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: withTimeout(signal)
  })
  if (!r.ok) throw new Error(`谷歌翻译 ${r.status}`)
  const j = JSON.parse(await r.text()) as Array<Array<[string, string]>>
  return ((j?.[0] ?? []) as Array<[string, string]>).map((seg) => seg?.[0] ?? '').join('')
}

// ---------- 必应（网页版后端：translator 页取 IG/IID/防滥用参数） ----------
// 老的 Edge 免费接口（edge.microsoft.com/translate/auth）已下线 404，只能走网页版；
// 参数约 1 小时有效，缓存 30 分钟，失效（statusCode 205）时强刷重试一次

interface BingParams {
  ig: string
  iid: string
  key: string
  token: string
  at: number
}
const BING_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
let bingParams: BingParams | null = null

async function bingParamsFetch(signal?: AbortSignal, force = false): Promise<BingParams> {
  if (!force && bingParams && Date.now() - bingParams.at < 30 * 60_000) return bingParams
  const page = await (
    await fetch('https://www.bing.com/translator', {
      headers: { 'User-Agent': BING_UA },
      signal: withTimeout(signal)
    })
  ).text()
  const ig = page.match(/IG:"([^"]+)"/)?.[1] ?? ''
  const iid = page.match(/iid="([^"]+)"/)?.[1] ?? 'translator.5024'
  const parts = page
    .match(/params_AbusePreventionHelper\s*=\s*\[([^\]]+)\]/)?.[1]
    ?.split(',')
    .map((s) => s.replace(/"/g, '').trim())
  if (!ig || !parts?.[0] || !parts?.[1]) throw new Error('必应翻译页面参数缺失')
  bingParams = { ig, iid, key: parts[0], token: parts[1], at: Date.now() }
  return bingParams
}

async function bingTranslateOnce(text: string, to: string, p: BingParams, signal?: AbortSignal): Promise<string> {
  // 必应的简体中文代码是 zh-Hans（zh-CN 是谷歌系写法）；fromLang 只认 auto-detect，不认 auto
  const toBing = to === 'zh-CN' ? 'zh-Hans' : to
  const r = await fetch(`https://www.bing.com/ttranslatev3?IG=${encodeURIComponent(p.ig)}&IID=${encodeURIComponent(p.iid)}`, {
    method: 'POST',
    headers: {
      'User-Agent': BING_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://www.bing.com/translator'
    },
    body: new URLSearchParams({
      fromLang: 'auto-detect',
      to: toBing,
      text,
      token: p.token,
      key: p.key,
      tryFetchingGenderDebiasedTranslations: 'false'
    }).toString(),
    signal: withTimeout(signal)
  })
  if (!r.ok) throw new Error(`必应翻译 ${r.status}`)
  const j = (await r.json().catch(() => null)) as
    | Array<{ translations?: Array<{ text?: string }>; statusCode?: number }>
    | { statusCode?: number; errorMessage?: string }
    | null
  // 参数失效返回 200 + {"statusCode":205,...}，正常翻译返回 [{translations:[...]}]
  const out = Array.isArray(j) ? (j[0]?.translations ?? []).map((t) => t.text ?? '').join('') : ''
  if (!out.trim()) {
    const code = Array.isArray(j) ? (j[0]?.statusCode ?? 205) : (j?.statusCode ?? 205)
    throw new Error(`必应翻译 ${code}`)
  }
  return out
}

async function bingTranslate(text: string, to: string, signal?: AbortSignal): Promise<string> {
  try {
    return await bingTranslateOnce(text, to, await bingParamsFetch(signal), signal)
  } catch {
    return await bingTranslateOnce(text, to, await bingParamsFetch(signal, true), signal)
  }
}

const ENGINES: Record<'google' | 'bing', (text: string, to: string, signal?: AbortSignal) => Promise<string>> = {
  google: googleTranslate,
  bing: bingTranslate
}

// 按设置选引擎翻译；失败自动换另一家兜底（两家都失败才抛错）
export async function freeTranslate(text: string, target: string, signal?: AbortSignal): Promise<string> {
  const to = targetCode(target)
  const prefer: 'google' | 'bing' = getSettings().translateEngine === 'bing' ? 'bing' : 'google'
  const order: Array<'google' | 'bing'> = prefer === 'google' ? ['google', 'bing'] : ['bing', 'google']
  let lastErr: unknown = new Error('无可用翻译引擎')
  for (const name of order) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      const out = await ENGINES[name](text, to, signal)
      if (out.trim()) return out
      lastErr = new Error('翻译结果为空')
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}
