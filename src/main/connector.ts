// 浏览器扩展导入（做法参考 Zotero Connector）：应用在本机开一个只对浏览器扩展开放的 HTTP 服务。
// 浏览器扩展把论文页面的元数据发过来，PDF 由浏览器带着当前登录态下载后一并上传，应用负责入库。
//
// 相比内置浏览器：用户在自己常用的浏览器里操作，机构账号、校园网认证都是现成的，不必在应用里再登录一次。
//
// 安全边界（本机 HTTP 服务，任何网页都可能尝试访问）：
//   - Host 必须是回环地址（防 DNS 重绑定：别的域名解析到 127.0.0.1 后同源读取响应）
//   - 写操作只认浏览器扩展来源（chrome-extension:// 等），普通网页的来源一律 403
//   - 还必须带自定义头：网页脚本发自定义头得先过预检，而预检只对扩展来源放行——
//     两道叠加后，恶意网页连「表单直 POST」这种不需要预检的路子也走不通
//   - 请求体有大小上限，载荷逐字段校验；外部给的一切（网址、标题、文件名）都不直接信任

import { app, session, shell } from 'electron'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { importPapers } from './import'
import { getDb, getMeta, getSettings, setMeta, listCategoryNames } from './db'
import { httpFetch } from './http'
import { oaPdfUrlsForDoi } from './refmeta'

export interface ConnectorActivity {
  at: number
  // ping = 扩展在探测服务；save = 一次保存请求
  kind: 'ping' | 'save'
  title?: string
  // saved = 新入库；duplicate = 已在文库；no-pdf = 没取到全文；error = 失败
  status?: 'saved' | 'duplicate' | 'no-pdf' | 'error'
  message?: string
  // pdf = 浏览器把 PDF 一起传来了；metadata = 只传来元数据、全文由应用自己取
  via?: 'pdf' | 'metadata'
}

export interface ConnectorStatus {
  running: boolean
  port: number | null
  // 启动失败的原因（如端口全部被占用）
  error?: string
  // 扩展目录（用户把它加载进浏览器）
  dir: string
  // 目录确实存在（打包或源码里带了扩展）
  dirExists: boolean
  // 自启动以来是否收到过扩展的请求
  seen: boolean
  lastSeenAt: number | null
}

export interface ConnectorHost {
  send: (ev: string, payload: unknown) => void
  // 入库成功后：主窗口刷新列表、排队建索引、把新论文打开（不抢焦点）
  onImported: (slug: string) => void
}

const API_VERSION = 1
// 扩展按 23420–23429 依次探测；前一个被占用就往后挪
const PORT_BASE = 23420
const PORT_TRIES = 10
const JSON_MAX = 256 * 1024
const PDF_MAX = 150 * 1024 * 1024
const RECENT_MAX = 20

let host: ConnectorHost | null = null
let server: http.Server | null = null
let port: number | null = null
let startError = ''
let lastSeenAt: number | null = null
let recent: ConnectorActivity[] = []

// ---------- 载荷校验 ----------

// 扩展发来的一条论文元数据。所有字段都来自外部：类型、长度逐项收紧
interface ConnectorItem {
  title: string
  creators: string
  year: number | null
  doi: string
  venue: string
  url: string
  // 候选 PDF 地址
  attachments: string[]
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const isHttp = (u: string): boolean => /^https?:\/\//i.test(u)

function normalizeItem(raw: unknown): ConnectorItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const attachments = (Array.isArray(o.attachments) ? o.attachments : [])
    .map((a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a as { url?: unknown }).url : ''))
    .filter((u): u is string => typeof u === 'string' && isHttp(u))
    .slice(0, 8)
  const title = clean(o.title, 300)
  // 既没有标题也没有 PDF 地址：不算一条有效的论文记录
  if (!title && !attachments.length) return null
  // 作者可能是字符串，也可能是 {firstName,lastName} 数组
  const rawCreators: unknown = o.creators ?? o.authors
  const creators = Array.isArray(rawCreators)
    ? rawCreators
        .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' ? clean((c as { firstName?: unknown }).firstName, 80) + ' ' + clean((c as { lastName?: unknown }).lastName, 80) : ''))
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ')
        .slice(0, 500)
    : clean(rawCreators, 500)
  const dateRaw = typeof o.date === 'string' || typeof o.date === 'number' ? String(o.date) : ''
  const ym = (dateRaw.match(/(1[89]|20)\d{2}/) ?? [])[0]
  return {
    title,
    creators,
    year: ym ? parseInt(ym, 10) : null,
    doi: clean(o.doi ?? o.DOI, 200).replace(/^(doi:\s*|https?:\/\/(dx\.)?doi\.org\/)/i, ''),
    venue: clean(o.venue ?? o.publicationTitle, 200),
    url: isHttp(clean(o.url, 2000)) ? clean(o.url, 2000) : '',
    attachments
  }
}

// ---------- PDF 抓取（扩展只传来元数据时，应用自己取全文） ----------

let browserUa = ''
// 应用自己发请求时以标准浏览器身份访问：出版商站点对带 Electron 标识的 UA 常返回降级页面
function ua(): string {
  if (!browserUa) {
    try {
      browserUa = session.defaultSession.getUserAgent().replace(/\s*Electron\/[\d.]+/i, '').replace(/\s*paperlens\/[\d.]+/i, '')
    } catch {
      browserUa = 'Mozilla/5.0'
    }
  }
  return browserUa
}

// 套壳页（IEEE 的 stamp.jsp 等）里真正的 PDF 地址
function pdfInHtml(html: string, base: string): string {
  const pick = (re: RegExp): string => {
    const m = html.match(re)
    if (!m) return ''
    try {
      return new URL(m[1].replace(/&amp;/g, '&'), base).href
    } catch {
      return ''
    }
  }
  return (
    pick(/<(?:iframe|embed|object)[^>]*?(?:src|data)\s*=\s*["']([^"']+)["']/i) ||
    pick(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
    pick(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i) ||
    pick(/href=["']([^"']*\.pdf(?:[?#][^"']*)?)["']/i)
  )
}

async function grab(url: string, referer: string, depth = 0): Promise<Buffer | null> {
  if (!isHttp(url) || depth > 2) return null
  let res: Response
  try {
    res = await httpFetch(url, {
      headers: { 'User-Agent': ua(), Accept: 'application/pdf,*/*;q=0.8', ...(isHttp(referer) ? { Referer: referer } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(90_000)
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)))
  if (buf.length > PDF_MAX) return null
  // %PDF 头前可能带少量垃圾字节，在头 1KB 内找；太小的不可能是论文
  if (buf.length > 800 && looksLikePdf(buf)) return buf
  if (depth >= 2) return null
  // 是不是网页不能只看 Content-Type：网关 / 代理漏发这个头并不少见，以内容本身为准
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
  const head = buf.toString('latin1', 0, 2048).trimStart().toLowerCase()
  if (!(/html|xml|text/.test(ctype) || head.startsWith('<'))) return null
  const next = pdfInHtml(buf.toString('utf8', 0, 400_000), url)
  return next && next !== url ? grab(next, referer, depth + 1) : null
}

const looksLikePdf = (buf: Buffer): boolean => buf.length > 800 && buf.subarray(0, 1024).includes('%PDF')

// 直接打开的 PDF 没有元数据：拿地址末段当标题（导入时还会走 AI 识别 / 学术库补全）
function titleFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
    return last.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || url
  } catch {
    return url
  }
}

// ---------- 入库 ----------

type SaveResult =
  | { ok: true; status: 'saved' | 'duplicate'; slug: string; title: string }
  | { ok: false; status: 'no-pdf' | 'invalid' | 'error'; message: string }

const normTitle = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')

// 文件名只留安全字符：临时文件要沿用下载名 / 地址末段，但二者都来自外部
function safeStem(name: string): string {
  return (name || 'paper').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.pdf$/i, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'paper'
}

// 待导入 PDF 的落盘位置：<临时目录>/paperlens-import/<时间戳-随机>/<文件名>.pdf。
// 目录负责防重名，文件名保持干净可用（没有元数据时导入链靠文件名当标题）
function tempPdfPath(stem: string): string {
  const dir = path.join(app.getPath('temp'), 'paperlens-import', `${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${stem}.pdf`)
}

// 用完清理：连同那一层独立目录一起删，不在临时目录里留空壳
function removeTempPdf(file: string): void {
  try {
    fs.rmSync(file, { force: true })
    const dir = path.dirname(file)
    // 只清自己建的目录，避免误删别的东西
    if (path.basename(path.dirname(dir)) === 'paperlens-import') fs.rmdirSync(dir)
  } catch {
    /* 临时文件清不掉不影响功能 */
  }
}

// 导入链内部是串行的（import.ts 的 importChain）：连续保存多篇时各自排队、各自拿到自己的结果
async function importPdf(file: string, item: ConnectorItem | null, category: string): Promise<SaveResult> {
  const title = item?.title || (item?.attachments[0] ? titleFromUrl(item.attachments[0]) : '')
  // 去重：库里已有同名论文就不再入库（标题归一化比对；只有几个字符的标题不比，避免误判）
  const key = normTitle(title)
  const dup =
    key.length >= 5
      ? (getDb().prepare('SELECT slug, title FROM papers').all() as Array<{ slug: string; title: string }>).find((p) => normTitle(p.title) === key)
      : undefined
  if (dup) {
    host?.onImported(dup.slug) // 已在文库：也让主窗口把这篇打开——用户又存了一次，多半是想看它
    return { ok: true, status: 'duplicate', slug: dup.slug, title: dup.title }
  }
  try {
    const outcomes = await importPapers(
      [
        {
          path: file,
          category, // '' = 交给 AI 归类；其余为分类名或 inbox
          // 标题非空才把页面元数据交给导入链；否则让它按文件名 / AI 识别 / 学术库补全
          ...(title ? { meta: { title, authors: item?.creators ?? '', year: item?.year ?? null, venue: item?.venue ?? '' } } : {})
        }
      ],
      () => {} // 进度只体现在返回结果里
    )
    const ok = outcomes.find((o) => o.ok)
    if (!ok?.slug) return { ok: false, status: 'error', message: outcomes[0]?.error ? `导入失败：${String(outcomes[0].error).slice(0, 160)}` : '导入失败' }
    host?.onImported(ok.slug)
    return { ok: true, status: 'saved', slug: ok.slug, title: ok.title ?? title }
  } catch (err) {
    return { ok: false, status: 'error', message: `导入失败：${String(err).slice(0, 160)}` }
  }
}

// 浏览器把 PDF 一起传上来了：直接落盘入库
async function saveWithPdf(item: ConnectorItem | null, pdf: Buffer, category: string): Promise<SaveResult> {
  // 浏览器说这是 PDF 不代表它真是：站点没登录时常返回一个登录页 / 错误页，内容照样会被传上来。
  // 入库前验一下文件头，不是 PDF 就拒收——否则文献库里会多出一篇打不开的「论文」
  if (!looksLikePdf(pdf)) {
    return { ok: false, status: 'invalid', message: '浏览器传来的不是 PDF 文件（站点可能返回了登录页或错误页）。请先在浏览器里登录，或直接打开 PDF 页面后再保存' }
  }
  const file = tempPdfPath(safeStem(item?.title || (item?.attachments[0] ? titleFromUrl(item.attachments[0]) : 'paper')))
  fs.writeFileSync(file, pdf)
  try {
    return await importPdf(file, item, category)
  } finally {
    removeTempPdf(file)
  }
}

// 只传来元数据：应用自己取全文。开放获取的（Unpaywall / Semantic Scholar 的直链）和
// 校园网 IP 授权的站点不需要登录态，这条路就够了；需要 Cookie 的站点取不到，由扩展那边先下载
async function saveMetadataOnly(item: ConnectorItem, category: string): Promise<SaveResult> {
  const candidates: string[] = []
  const push = (u: string): void => {
    if (isHttp(u) && !candidates.includes(u)) candidates.push(u)
  }
  item.attachments.forEach(push)
  if (item.doi) (await oaPdfUrlsForDoi(item.doi)).forEach(push)
  for (const url of candidates) {
    const buf = await grab(url, item.url || url)
    if (!buf) continue
    const file = tempPdfPath(safeStem(item.title || titleFromUrl(url)))
    fs.writeFileSync(file, buf)
    try {
      return await importPdf(file, item, category)
    } finally {
      removeTempPdf(file)
    }
  }
  return {
    ok: false,
    status: 'no-pdf',
    message: candidates.length
      ? '没能取到全文：这个站点需要登录才能下载 PDF。请先在浏览器里登录机构账号；或先用浏览器打开 PDF 页面，再点扩展保存'
      : '这个页面上没有找到可下载的 PDF'
  }
}

// ---------- HTTP 服务 ----------

// 浏览器扩展的来源。Firefox 每次安装生成随机 UUID，只能按协议前缀放行
const EXT_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[^\s/]+$/
const isLocalHost = (h: string): boolean => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h)

function corsFor(origin: string): Record<string, string> | null {
  if (!EXT_ORIGIN.test(origin)) return null
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-PaperLens-Connector, X-PaperLens-Item, X-PaperLens-Category',
    'Access-Control-Max-Age': '86400'
  }
}

function reply(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', ...headers })
  res.end(data)
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function record(a: ConnectorActivity): void {
  lastSeenAt = a.at
  if (a.kind === 'save') {
    recent = [a, ...recent].slice(0, RECENT_MAX)
  }
  host?.send('connector:activity', a)
}

const categories = (): string[] => listCategoryNames().filter((c) => c !== 'inbox')

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // 第一道门：Host 必须是回环地址
  if (!isLocalHost(String(req.headers.host ?? ''))) return reply(res, 403, { error: 'forbidden' })
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  const cors = corsFor(origin)
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

  // 预检：只对扩展来源放行。普通网页的自定义头请求在这里就被挡下，真正的请求根本发不出去
  if (req.method === 'OPTIONS') {
    if (!cors) return reply(res, 403, { error: 'forbidden' })
    res.writeHead(204, {
      ...cors,
      // Chrome 的私有网络访问：浏览器扩展页面向本机发请求时会在预检里问这一句
      ...(req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {})
    })
    res.end()
    return
  }

  // 探测是公开的（扩展启动时挨个端口问「PaperLens 在吗」）。对非扩展来源不下发 CORS 头，
  // 浏览器会拦住它读取响应，网页无从得知这台机器上有没有 PaperLens
  if (pathname === '/connector/ping' && (req.method === 'POST' || req.method === 'GET')) {
    record({ kind: 'ping', at: Date.now() })
    return reply(
      res,
      200,
      { app: 'PaperLens', version: app.getVersion() },
      { ...cors, 'X-PaperLens-Connector-API-Version': String(API_VERSION) }
    )
  }

  // 第二、三道门：来源必须是浏览器扩展，且带自定义头（挡住不需要预检的「表单直 POST」）
  if (!cors || req.headers['x-paperlens-connector'] !== '1') return reply(res, 403, { error: 'forbidden' }, cors ?? {})

  if (pathname === '/connector/info' && (req.method === 'GET' || req.method === 'POST')) {
    return reply(res, 200, { app: 'PaperLens', version: app.getVersion(), apiVersion: API_VERSION, categories: categories(), defaultCategory: connectorCategory(), aiClassify: !!getSettings().apiKey }, cors)
  }

  if (pathname === '/connector/save' && req.method === 'POST') {
    const asPdf = /^application\/pdf\b/i.test(String(req.headers['content-type'] ?? ''))
    const body = await readBody(req, asPdf ? PDF_MAX : JSON_MAX)
    let itemRaw: unknown
    let category = ''
    let via: 'pdf' | 'metadata'
    if (asPdf) {
      // PDF 走请求体；元数据放请求头（base64 的 JSON）
      via = 'pdf'
      let meta: { item?: unknown; category?: unknown }
      try {
        meta = JSON.parse(Buffer.from(String(req.headers['x-paperlens-item'] ?? ''), 'base64').toString('utf8')) as typeof meta
      } catch {
        return reply(res, 400, { ok: false, status: 'invalid', message: '请求头里的论文信息无法解析' } satisfies SaveResult, cors)
      }
      itemRaw = meta.item
      category = clean(meta.category, 60)
    } else {
      via = 'metadata'
      let payload: { item?: unknown; category?: unknown }
      try {
        payload = JSON.parse(body.toString('utf8')) as typeof payload
      } catch {
        return reply(res, 400, { ok: false, status: 'invalid', message: '请求体不是合法的 JSON' } satisfies SaveResult, cors)
      }
      itemRaw = payload.item
      category = clean(payload.category, 60)
    }
    const item = normalizeItem(itemRaw)
    if (!item) return reply(res, 400, { ok: false, status: 'invalid', message: '没有收到有效的论文信息' } satisfies SaveResult, cors)
    // 分类只认库里现有的名字；__auto__ = AI 归类；其余一律未分类
    if (category !== '__auto__') category = categories().includes(category) ? category : 'inbox'
    else category = ''
    const started = Date.now()
    const result = asPdf ? await saveWithPdf(item, body, category) : await saveMetadataOnly(item, category)
    console.log(`[connector] ${via} · ${result.status} · ${result.ok ? result.title : result.message} · ${Date.now() - started}ms`)
    record({
      kind: 'save',
      at: Date.now(),
      title: result.ok ? result.title : item.title || item.attachments[0] || '',
      status: result.status === 'invalid' ? 'error' : result.status,
      message: result.ok ? undefined : result.message,
      via
    })
    return reply(res, 200, result, cors)
  }

  return reply(res, 404, { error: 'not found' }, cors)
}

// ---------- 生命周期 ----------

export function startConnector(h: ConnectorHost): void {
  if (server || port) return
  host = h
  const attempt = (n: number): void => {
    if (n >= PORT_TRIES) {
      server = null
      port = null
      startError = `${PORT_BASE}–${PORT_BASE + PORT_TRIES - 1} 端口都被占用，扩展导入服务没能启动。可在「浏览器扩展导入」里点「重新启动服务」`
      console.error('[connector]', startError)
      return
    }
    const s = http.createServer((req, res) => {
      void handle(req, res).catch((err) => {
        try {
          reply(res, 500, { ok: false, status: 'error', message: `服务内部错误：${String(err).slice(0, 160)}` } satisfies SaveResult)
        } catch {
          /* 响应已发出 */
        }
      })
    })
    s.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') return attempt(n + 1)
      server = null
      port = null
      startError = `扩展导入服务启动失败：${String(err.message ?? err).slice(0, 160)}`
      console.error('[connector]', startError)
    })
    s.listen(PORT_BASE + n, '127.0.0.1', () => {
      console.log(`[connector] 浏览器扩展导入服务已就绪：http://127.0.0.1:${PORT_BASE + n}/connector`)
    })
    server = s
    port = PORT_BASE + n
  }
  attempt(0)
}

export function stopConnector(): void {
  if (server) {
    server.close()
    server = null
  }
  port = null
}

export function restartConnector(h: ConnectorHost): ConnectorStatus {
  stopConnector()
  startError = ''
  startConnector(h)
  return connectorStatus()
}

// 扩展目录：随安装包放在资源目录；开发态就是源码里的 connector/
export function connectorDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'connector') : path.join(app.getAppPath(), 'connector')
}

export function connectorStatus(): ConnectorStatus {
  return {
    running: !!port,
    port,
    ...(startError ? { error: startError } : {}),
    dir: connectorDir(),
    dirExists: fs.existsSync(path.join(connectorDir(), 'manifest.json')),
    seen: lastSeenAt != null,
    lastSeenAt
  }
}

export function recentActivity(): ConnectorActivity[] {
  return recent
}

export function connectorCategory(): string {
  return getMeta('connectorCategory') ?? ''
}

export function setConnectorCategory(cat: string): void {
  setMeta('connectorCategory', cat)
}

export async function openConnectorDir(): Promise<string> {
  const dir = connectorDir()
  if (!fs.existsSync(dir)) return `找不到扩展目录：${dir}`
  // 返回空串表示成功；否则是错误信息
  return shell.openPath(dir)
}
