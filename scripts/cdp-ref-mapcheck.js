// byNum 映射正确性断言：应用内索引 vs 已知条目（含此前丢失的 1-9 与被误拒的 19）
const WebSocket = require('ws')
const PORT = parseInt(process.env.CDP_PORT || '9222')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  let page = null
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
      if (page) break
    } catch {}
    await sleep(1000)
  }
  if (!page) throw new Error('no CDP target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } })
  const ev = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value })
  function send(method, params = {}) { return new Promise((res, rej) => { const m = ++id; pend.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })) }) }
  // 打开 bondwire 并等索引后台预热
  await ev(`[...document.querySelectorAll('.cat-item')].forEach(c => { const ch = c.querySelector('.chev, svg'); (ch ?? c).click() })`).catch(() => {})
  await sleep(700)
  await ev(`[...document.querySelectorAll('.paper-item')].find(e => /bondwire/i.test(e.textContent)).click()`)
  await sleep(7000)
  const r = await ev(`(() => {
    const idx = window.__refIdx?.current?.index
    if (!idx) return { error: 'index not ready' }
    const get = (n) => { const e = idx.byNum.get(n); return e ? e.raw.slice(0, 120) : null }
    return {
      entries: idx.entries.length,
      e1: get(1), e3: get(3), e10: get(10), e19: get(19), e26: get(26),
      nums: idx.entries.map(e => e.num)
    }
  })()`)
  console.log(JSON.stringify(r, null, 1))
  const nums = r.nums || []
  const contiguous = nums.length === 26 && nums.every((n, i) => n === i + 1)
  const checks = {
    entries26: r.entries === 26,
    contiguous,
    e1_transitioning: /transitioning/i.test(r.e1 || ''),
    e3_moore: /moore/i.test(r.e3 || ''),
    e19_zhu: /zhu/i.test(r.e19 || ''),
  }
  console.log(checks, 'ALL', Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL')
  ws.close()
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
