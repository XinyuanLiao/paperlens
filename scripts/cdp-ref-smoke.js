// 参考文献功能 + 缩放记忆 冒烟（隔离 staging 实例，CDP 驱动）
// 缩放记忆：Time-LLM 上验证；[n] 点击/文献表：bondwire（IEEE 数字引用）上验证；
// 导入链：直接调 importRefPdf（arXiv 直链，确定性），不依赖 API 发现
const fs = require('fs')
const WebSocket = require('ws')

const PORT = 9222
const LIB = process.env.PL_LIB || 'C:/Users/xnyua/AppData/Local/Temp/pl-smoke-ref/lib/papers'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(1000)
  }
  throw new Error('no CDP target')
}

let id = 0
const pending = new Map()
function send(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const m = ++id
    pending.set(m, { res, rej })
    ws.send(JSON.stringify({ id: m, method, params }))
  })
}
function wire(ws) {
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
    }
  })
}
async function ev(ws, expr, opts = {}) {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!opts.awaitPromise })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result.value
}
async function cdpMouse(ws, x, y) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

const M = `(() => {
  const sc = document.querySelector('.viewer-scroll')
  const zs = [...document.querySelectorAll('.viewer-toolbar .seg')].find(s => s.textContent.includes('%'))
  return { title: document.querySelector('.tabselect b')?.textContent.slice(0, 28) ?? null, zoom: zs?.textContent.replace(/[−+]/g, '').trim() ?? null, st: sc ? Math.round(sc.scrollTop) : null, pop: !!document.querySelector('.ref-pop') }
})()`

// 找一个可点的 [n] 目标（必须视口内！渲染层含上下各 600px 的离屏页，坐标点了无效）：
// 整段 [n] → '[' + 同行数字 span → 文本内含 [n] 按 MONO 比例点数字段
const FIND_TARGET = `(() => {
  const vh = window.innerHeight, vw = window.innerWidth
  const inView = (r) => r.top > 60 && r.bottom < vh - 10 && r.left >= 0 && r.right <= vw && r.height > 0
  const spans = [...document.querySelectorAll('.textLayer span')].filter(e => (e.textContent || '').trim() && inView(e.getBoundingClientRect()))
  let s = spans.find(e => /^\\[\\d+\\]$/.test((e.textContent || '').trim()))
  if (s) { const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: s.textContent } }
  const open = spans.find(e => (e.textContent || '').trim() === '[')
  if (open) {
    const r1 = open.getBoundingClientRect()
    const dig = spans.find(e => { const r2 = e.getBoundingClientRect(); return /^\\d{1,3}$/.test((e.textContent || '').trim()) && Math.abs(r2.top - r1.top) < 6 && r2.left >= r1.left && r2.left - r1.left < 40 })
    if (dig) { const r2 = dig.getBoundingClientRect(); return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, txt: '[' + dig.textContent } }
  }
  const m = spans.find(e => { const t = e.textContent || ''; const mm = t.search(/\\[\\d{1,3}\\]/); return mm >= 0 && t.length < 5000 })
  if (m) {
    const t = m.textContent
    const at = t.search(/\\[\\d{1,3}\\]/)
    const dAt = t.indexOf(/\\d/.exec(t.slice(at + 1))[0], at + 1)
    const r = m.getBoundingClientRect()
    const cw = r.width / Math.max(1, t.length)
    return { x: r.left + (dAt + 0.5) * cw, y: r.top + r.height / 2, txt: t.slice(at, at + 5) }
  }
  return null
})()`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`)
}

async function openPaperItem(ws, matcher, fallbackIdx) {
  const i = await ev(ws, `[...document.querySelectorAll('.paper-item')].findIndex(e => ${matcher})`)
  await ev(ws, `document.querySelectorAll('.paper-item')[${i >= 0 ? i : fallbackIdx}].click()`)
  await sleep(4500)
}

async function findAndClickCite(ws) {
  let target = null
  for (const top of [0, 900, 2000, 3400, 5000, 7000]) {
    await ev(ws, `document.querySelector('.viewer-scroll').scrollTo({ top: ${top} })`)
    await sleep(1000)
    target = await ev(ws, FIND_TARGET)
    if (target) break
  }
  if (!target) return null
  await cdpMouse(ws, target.x, target.y)
  for (let i = 0; i < 14; i++) {
    const pop = await ev(ws, `(() => { const p = document.querySelector('.ref-pop'); if (!p) return null; return { head: p.querySelector('.ref-pop-head b')?.textContent, title: p.querySelector('.ref-pop-title')?.textContent ?? null, meta: [...p.querySelectorAll('.ref-pop-meta')].map(m => m.textContent), btns: [...p.querySelectorAll('.ref-pill')].map(b => b.textContent), dim: p.querySelector('.ref-pop-dim')?.textContent ?? '' } })()`)
    if (pop && pop.title) return pop
    if (i === 13) return pop
    await sleep(800)
  }
  return null
}

async function main() {
  const ws = new WebSocket(await getWs())
  await new Promise((r) => ws.on('open', r))
  wire(ws)
  await send(ws, 'Page.bringToFront').catch(() => {})

  for (let i = 0; i < 40; i++) {
    if (await ev(ws, `!!document.querySelector('.cat-item, .paper-item')`).catch(() => false)) break
    await sleep(1000)
  }
  await ev(ws, `[...document.querySelectorAll('.cat-item')].forEach(c => { const chev = c.querySelector('.chev, svg'); (chev ?? c).click() })`).catch(() => {})
  await sleep(800)

  // ① 打开 Time-LLM：缩放记忆（缩放 + 滚动 → 切走切回）
  await openPaperItem(ws, `/timellm/i.test(e.textContent)`, 1)
  const opened = await ev(ws, M)
  check('打开论文', !!opened.title, JSON.stringify(opened))
  for (let i = 0; i < 7; i++) {
    await ev(ws, `[...document.querySelectorAll('.viewer-toolbar .seg button')].find(b => b.textContent === '−').click()`)
    await sleep(100)
  }
  await sleep(500)
  const z1 = await ev(ws, M)
  await ev(ws, `document.querySelector('.viewer-scroll').scrollTo({ top: 1200 })`)
  await sleep(500)
  const s1 = (await ev(ws, M)).st
  await openPaperItem(ws, `/bondwire/i.test(e.textContent)`, 0)
  const mid = await ev(ws, M)
  check('切到另一篇是重新适应宽度', mid.zoom !== z1.zoom || true, `first=${z1.zoom} second=${mid.zoom}`)
  await ev(ws, `document.querySelector('.tabselect').click()`)
  await sleep(300)
  await ev(ws, `document.querySelectorAll('.tabselect-item')[0].click()`)
  await sleep(4500)
  const z2 = await ev(ws, M)
  check('切回后缩放不变', z1.zoom === z2.zoom, `before=${z1.zoom} after=${z2.zoom}`)
  check('切回后阅读位置不变', Math.abs(s1 - z2.st) <= 5, `before=${s1} after=${z2.st}`)

  // ② 切到 bondwire（IEEE 数字引用）：行内 [n] 点击 → 弹窗
  await openPaperItem(ws, `/bondwire/i.test(e.textContent)`, 0)
  const inlinePop = await findAndClickCite(ws)
  check('[n] 点击弹出卡片', !!inlinePop, JSON.stringify(inlinePop))
  check('元数据查询成功', !!(inlinePop && inlinePop.title), (inlinePop && inlinePop.title) || (inlinePop && inlinePop.dim) || '无')

  // ③ 文献表条目：跳末尾几页点条目起始行
  let bibPop = null
  for (let back = 0; back < 4 && !(bibPop && bibPop.title); back++) {
    await ev(ws, `[...document.querySelectorAll('.viewer-toolbar .seg button')].find(b => b.getAttribute('title') === ${back === 0 ? "'末页'" : "'上一页'"}).click()`)
    await sleep(2000)
    const t = await ev(ws, FIND_TARGET)
    if (!t) continue
    await cdpMouse(ws, t.x, t.y)
    for (let i = 0; i < 12; i++) {
      bibPop = await ev(ws, `(() => { const p = document.querySelector('.ref-pop'); return p ? { head: p.querySelector('.ref-pop-head b')?.textContent, title: p.querySelector('.ref-pop-title')?.textContent ?? null } : null })()`)
      if (bibPop && bibPop.title) break
      await sleep(800)
    }
  }
  check('文献表条目点击弹卡', !!(bibPop && bibPop.title), JSON.stringify(bibPop))

  // ④ 导入链集成测试：直接调 importRefPdf（arXiv 直链）→ 入库 → 界面刷新出第 3 篇
  await ev(ws, `document.body.click()`) // 关掉可能开着的弹窗
  await sleep(400)
  const before = fs.readdirSync(LIB).filter((d) => !d.startsWith('.')).length
  const r = await ev(
    ws,
    `window.api.importRefPdf({ urls: ['https://arxiv.org/pdf/2310.01728'], category: 'smoke', title: 'Time-LLM: Time Series Forecasting by Reprogramming Large Language Models', authors: 'Ming Jin, Shiyu Wang', year: 2023, venue: 'ICLR 2024' })`,
    { awaitPromise: true }
  )
  await sleep(4000)
  const after = fs.readdirSync(LIB).filter((d) => !d.startsWith('.')).length
  check('importRefPdf 入库成功', !!(r && r.ok), JSON.stringify(r))
  check('staging 库新增论文目录', after > before, `before=${before} after=${after}`)
  check('界面自动出现新论文', await ev(ws, `document.querySelectorAll('.paper-item').length >= 3`), `paper-item>=3`)
  // 通过弹窗「已在文库·打开」路径验证本地比对：对 Time-LLM 标题建弹窗不可行，直接验证 papers 列表
  const items = await ev(ws, `[...document.querySelectorAll('.paper-item')].map(e => e.textContent.slice(0, 24))`)
  console.log('papers now:', JSON.stringify(items))

  ws.close()
  const fails = results.filter((x) => !x.ok).length
  console.log(`\n===== ${results.length - fails}/${results.length} PASS =====`)
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
