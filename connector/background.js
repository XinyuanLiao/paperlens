// PaperLens Connector 的后台（service worker）。只做两件事：
//   1) 找到本机的 PaperLens：依次探测 23420–23429 端口（前一个被占用时应用会往后挪）
//   2) 保存：在浏览器里把 PDF 取下来（带着当前登录状态），连同元数据一起交给 PaperLens 入库
//
// 与应用的通信走本机 HTTP（参考 Zotero Connector 的做法）。请求都带自定义头 X-PaperLens-Connector，
// 应用那边只认浏览器扩展的来源 + 这个头——普通网页没法伪造，所以这个本机服务不会被恶意页面利用。

const PORTS = Array.from({ length: 10 }, (_, i) => 23420 + i)
const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-PaperLens-Connector': '1' }

// 这次会话里找到的服务地址：省得每次都挨个端口探测
let appBase = null

async function ping(base) {
  const r = await fetch(base + '/connector/ping', { method: 'POST', headers: JSON_HEADERS, body: '{}', signal: AbortSignal.timeout(1500) })
  return r.ok
}

async function findApp() {
  if (appBase) {
    try {
      if (await ping(appBase)) return appBase
    } catch (e) {
      /* 应用可能刚退出：落到下面重新探测 */
    }
    appBase = null
  }
  for (const p of PORTS) {
    const base = 'http://127.0.0.1:' + p
    try {
      if (await ping(base)) {
        appBase = base
        return base
      }
    } catch (e) {
      /* 这个端口上没有服务：试下一个 */
    }
  }
  return null
}

// %PDF 头前可能带少量垃圾字节，在头 1KB 内找；太小的不会是论文
const looksLikePdf = (buf) => buf.length > 800 && new TextDecoder('latin1').decode(buf.subarray(0, 1024)).includes('%PDF')

// 在浏览器里取 PDF：credentials: 'include' 带上该站点的 Cookie，所以机构登录、校园网认证都是现成的。
// 前提是用户授权过扩展访问这个站点（popup 在保存前申请，每个站点只问一次）——
// 没授权的跨站请求浏览器会直接拒绝，这里先问一句免得白跑
async function fetchPdf(urls) {
  for (const url of urls || []) {
    if (!/^https?:\/\//i.test(url)) continue
    let origin
    try {
      origin = new URL(url).origin
    } catch (e) {
      continue
    }
    const granted = await chrome.permissions.contains({ origins: [origin + '/*'] }).catch(() => false)
    if (!granted) continue
    try {
      const r = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(90000) })
      if (!r.ok) continue
      const buf = new Uint8Array(await r.arrayBuffer())
      if (looksLikePdf(buf)) return buf
    } catch (e) {
      /* 这个地址取不到（站点防护、返回的是网页而不是 PDF 等）：试下一个 */
    }
  }
  return null
}

// 元数据放请求头：UTF-8 文本 → base64（标题里有中文也能原样传过去）
function b64(text) {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  // fromCharCode 不接受太长的参数表：分段拼
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function save({ item, category }) {
  const base = await findApp()
  if (!base) {
    return {
      ok: false,
      status: 'error',
      message: '没有找到正在运行的 PaperLens。请先打开 PaperLens 桌面应用，再点一次扩展。'
    }
  }
  const meta = { item, category: category || '' }
  const pdf = await fetchPdf(item.attachments)
  try {
    if (pdf) {
      const r = await fetch(base + '/connector/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf', 'X-PaperLens-Connector': '1', 'X-PaperLens-Item': b64(JSON.stringify(meta)) },
        body: pdf
      })
      return await r.json()
    }
    // 浏览器里没取到（页面上没有 PDF 直链、或用户没授权这个站点）：
    // 只发元数据，让应用自己想办法——开放获取的论文和校园网 IP 授权的站点不需要登录态，应用直接就能下
    const r = await fetch(base + '/connector/save', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(meta) })
    return await r.json()
  } catch (e) {
    return { ok: false, status: 'error', message: '和 PaperLens 通信失败：' + (e && e.message ? e.message : e) }
  }
}

async function info() {
  const base = await findApp()
  if (!base) return null
  try {
    const r = await fetch(base + '/connector/info', { method: 'POST', headers: JSON_HEADERS, body: '{}' })
    return r.ok ? await r.json() : null
  } catch (e) {
    return null
  }
}

// popup ↔ 后台的消息：返回 true 表示稍后异步 sendResponse
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg && msg.type
  if (type === 'PING') findApp().then((base) => sendResponse({ ok: !!base })).catch(() => sendResponse({ ok: false }))
  else if (type === 'INFO') info().then((data) => sendResponse(data)).catch(() => sendResponse(null))
  else if (type === 'SAVE') save(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, status: 'error', message: String((e && e.message) || e) }))
  else return false
  return true
})
