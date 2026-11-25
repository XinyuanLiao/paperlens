// 联网请求的统一出口。应用内由入口换成 Chromium 的 net.fetch（跟随系统代理 / PAC 与
// 系统证书）；纯 Node 测试脚本里保持全局 fetch，模块自身不依赖 electron。
//
// 为什么要换：Node 全局 fetch 不读系统代理——挂代理访问 OpenAI、Google 学术服务、GitHub 的
// 用户会「浏览器能通、应用连不上」，而 Chromium 网络栈与浏览器行为一致。
//
// 两种实现抛错形态不同：Node 是 TypeError + cause.code，Chromium 是 message 里的 net::ERR_*，
// netErrorCode 把它们归一成一种错误码便于上层提示

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

let impl: FetchLike = (url, init) => fetch(url, init)

export function setHttpFetch(f: FetchLike): void {
  impl = f
}

// 供测试复位
export function resetHttpFetch(): void {
  impl = (url, init) => fetch(url, init)
}

export async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await impl(url, init)
  } catch (err) {
    // Chromium 拒绝访问「不安全端口」（6000、6667、10080…），本地自建服务偶尔会撞上；
    // 这种地址不需要代理，回退 Node fetch 即可
    if (/ERR_UNSAFE_PORT/.test(String(err))) return fetch(url, init)
    throw err
  }
}

// 用户主动中止（停止生成）：原样抛给调用方静默收尾，不要包装成「网络错误」
export function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  const msg = String((err as { message?: string } | null)?.message ?? err)
  return name === 'AbortError' || name === 'TimeoutError' || /aborted/i.test(msg)
}

// 网络层错误码：Node 的 cause.code 或 Chromium 的 net::ERR_*；没有则为空串
export function netErrorCode(err: unknown): string {
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code
  if (typeof cause === 'string' && cause) return cause
  const m = String((err as { message?: string } | null)?.message ?? err).match(/net::(ERR_[A-Z0-9_]+)/)
  return m ? m[1] : ''
}

// 错误码 → 一句人话的原因（给界面看）
export function netErrorReason(err: unknown): string {
  const code = netErrorCode(err)
  if (!code) {
    const msg = String((err as { message?: string } | null)?.message ?? err)
    return /certificate|cert|SSL|TLS/i.test(msg) ? '证书校验失败' : '网络错误'
  }
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(code)) return '域名无法解析，请检查地址拼写或网络'
  if (/CONNECTION_REFUSED|ECONNREFUSED/.test(code)) return '连接被拒绝（本地服务是否已启动）'
  if (/TIMEDOUT|TIMED_OUT|ETIMEDOUT/.test(code)) return '连接超时，网络不通或需要代理'
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) return '证书校验失败（公司网络的自签证书需加入系统信任）'
  if (/PROXY|TUNNEL/.test(code)) return '系统代理连接失败，请检查代理软件'
  if (/CONNECTION_RESET|ECONNRESET|EMPTY_RESPONSE|CONNECTION_CLOSED/.test(code)) return '连接被重置'
  if (/INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_ACCESS_DENIED/.test(code)) return '网络已断开或不可用'
  if (/BLOCKED_BY|ACCESS_DENIED|FORBIDDEN/.test(code)) return '请求被网络策略或安全软件拦截'
  return '网络错误'
}
