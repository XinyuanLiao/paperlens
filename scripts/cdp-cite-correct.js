// 引用点击正确性验证：bondwire [1]/[3] → 弹窗元数据标题
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json())
  const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const m = ++id; pend.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })) })
  const ev = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: !!arguments }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value })
  const evSync = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value })
  const mouse = async (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, ...(type === 'mouseMoved' ? { buttons: 0 } : { button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) })
  await send('Page.bringToFront').catch(() => {})
  await sleep(2000)

  // 关掉可能开着的弹窗
  await evSync(`document.body.click()`)
  await sleep(300)

  const FIND = `(() => {
    const vh = window.innerHeight, vw = window.innerWidth
    const inView = (r) => r.top > 60 && r.bottom < vh - 10 && r.left >= 0 && r.right <= vw && r.height > 0
    const spans = [...document.querySelectorAll('.textLayer span')].filter(e => (e.textContent || '').trim() && inView(e.getBoundingClientRect()))
    const re = /\\[\\d{1,3}\\]/
    let s = spans.find(e => re.test((e.textContent || '').trim()) && (e.textContent || '').length < 5000)
    if (!s) return null
    const t = s.textContent
    const at = t.search(re)
    const dAt = t.indexOf(/\\d/.exec(t.slice(at + 1))[0], at + 1)
    const r = s.getBoundingClientRect()
    const cw = r.width / Math.max(1, t.length)
    return { x: r.left + (dAt + 0.5) * cw, y: r.top + r.height / 2, txt: t.slice(at, at + 4) }
  })()`

  let pass = true
  for (const [label, expect] of [['[1]', 'Physics-of-Failure'], ['[3]', null]]) {
    // 关旧弹窗
    await evSync(`document.body.click()`)
    await sleep(300)
    let target = null
    for (const top of [0, 900, 2000, 3400]) {
      await evSync(`document.querySelector('.viewer-scroll').scrollTo({ top: ${top} })`)
      await sleep(1400)
      target = await evSync(FIND)
      if (target) break
    }
    if (!target) { console.log(`FAIL ${label} no target`); pass = false; continue }
    await mouse('mouseMoved', target.x, target.y)
    await sleep(300)
    await mouse('mousePressed', target.x, target.y)
    await mouse('mouseReleased', target.x, target.y)
    let title = null
    for (let i = 0; i < 14; i++) {
      title = await evSync(`document.querySelector('.ref-pop-title')?.textContent ?? null`)
      if (title) break
      await sleep(800)
    }
    const ok = !!title && (!expect || title.toLowerCase().includes(expect.toLowerCase()))
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} (${target.txt.trim()}): ${JSON.stringify(title)}`)
    if (!ok) pass = false
  }
  console.log(pass ? 'ALL PASS' : 'HAS FAIL')
  ws.close()
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
