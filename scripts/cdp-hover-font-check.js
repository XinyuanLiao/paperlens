// 悬停高亮 + 内置开源字体 验证（隔离 staging 实例）
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  let ws
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
      ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
      break
    } catch { await sleep(1000) }
  }
  let id = 0
  const pend = new Map()
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } })
  const send = (method, params = {}) => new Promise((res, rej) => { const m = ++id; pend.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })) })
  const ev = (e, opts = {}) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: !!opts.awaitPromise }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value })
  const mouse = async (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, ...(type === 'mouseMoved' ? { buttons: 0 } : { button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) })
  await send('Page.bringToFront').catch(() => {})
  await sleep(3000)
  await ev(`[...document.querySelectorAll('.cat-item')].forEach(c => { const ch = c.querySelector('.chev, svg'); (ch ?? c).click() })`)
  await sleep(600)
  await ev(`[...document.querySelectorAll('.paper-item')].find(e => /bondwire/i.test(e.textContent)).click()`)
  await sleep(6000) // 等索引后台预热

  // 找视口内真实的 [n] 引用标记（正则写在 JS 文件里，不经 heredoc 转义）
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
    return { x: r.left + (dAt + 0.5) * cw, y: r.top + r.height / 2, txt: t.slice(at, at + 5) }
  })()`
  let target = null
  for (const top of [0, 900, 2000, 3400, 5000]) {
    await ev(`document.querySelector('.viewer-scroll').scrollTo({ top: ${top} })`)
    await sleep(1600)
    target = await ev(FIND)
    if (target) { console.log('target at top', top, JSON.stringify(target)); break }
  }
  if (!target) { console.log('FAIL no target'); process.exit(1) }

  // 悬停 → .ref-hover 出现且落在标记附近，span 加 ref-hot（cursor:pointer）
  await mouse('mouseMoved', target.x, target.y)
  await sleep(500)
  const hover1 = await ev(`(() => {
    const h = document.querySelector('.ref-hover')
    const s = document.querySelector('.textLayer span.ref-hot')
    return h ? { cx: Math.round(h.getBoundingClientRect().left + h.getBoundingClientRect().width / 2), cy: Math.round(h.getBoundingClientRect().top + h.getBoundingClientRect().height / 2), cursor: s ? getComputedStyle(s).cursor : 'none' } : null
  })()`, { awaitPromise: true })
  console.log('hover on marker:', JSON.stringify(hover1), '| target:', JSON.stringify({ x: Math.round(target.x), y: Math.round(target.y) }))
  const near = hover1 && Math.abs(hover1.cx - target.x) < 30 && Math.abs(hover1.cy - target.y) < 14 && hover1.cursor === 'pointer'
  // 移开 → 高亮消失
  await mouse('mouseMoved', target.x + 300, target.y)
  await sleep(400)
  const hoverGone = (await ev(`!!document.querySelector('.ref-hover')`)) === false
  // 悬停后点击 → 弹窗照常
  await mouse('mouseMoved', target.x, target.y)
  await sleep(250)
  await mouse('mousePressed', target.x, target.y)
  await mouse('mouseReleased', target.x, target.y)
  await sleep(800)
  const pop = await ev(`(() => { const p = document.querySelector('.ref-pop'); return p ? (p.querySelector('.ref-pop-title')?.textContent || 'loading') : null })()`)
  await sleep(4000)
  console.log('click popup after hover:', JSON.stringify(pop))

  // 内置开源字体：像素 hash 验证（Literata 需 fonts.load 预载，界面无元素使用时不会自动加载）
  const fonts = await ev(`(async () => {
    await Promise.all([
      document.fonts.load('20px "Inter Variable"', 'PaperLens 123'),
      document.fonts.load('20px "Literata Variable"', 'Reply 123'),
      document.fonts.load('20px "Playfair Display Variable"', 'Welcome 2026')
    ])
    const render = (text, fam) => { const c = document.createElement('canvas'); c.width = 90; c.height = 40; const ctx = c.getContext('2d'); ctx.font = '20px ' + fam; ctx.fillText(text, 2, 28); const d = ctx.getImageData(0, 0, 90, 40).data; let h = 0; for (let i = 3; i < d.length; i += 4) h = (h * 31 + d[i]) | 0; return h }
    const bodyFF = getComputedStyle(document.body).fontFamily
    const serifStack = getComputedStyle(document.documentElement).getPropertyValue('--font-serif').trim()
    const dispStack = getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim()
    return {
      body_latin_is_inter: render('PaperLens 123', bodyFF) === render('PaperLens 123', 'Inter Variable') && render('PaperLens 123', 'Inter Variable') !== render('PaperLens 123', 'Segoe UI'),
      serif_latin_is_literata: render('Reply 123', serifStack) === render('Reply 123', 'Literata Variable') && render('Reply 123', 'Literata Variable') !== render('Reply 123', 'Cambria'),
      display_latin_is_playfair: render('Welcome 2026', dispStack) === render('Welcome 2026', 'Playfair Display Variable') && render('Welcome 2026', 'Playfair Display Variable') !== render('Welcome 2026', 'Georgia'),
      body_cjk_is_simsun: render('电力电子可靠性', bodyFF) === render('电力电子可靠性', 'SimSun'),
      families: [...document.fonts].map(f => f.family).filter((v, i, a) => a.indexOf(v) === i)
    }
  })()`, { awaitPromise: true })
  console.log('fonts:', JSON.stringify(fonts, null, 1))

  const pass = near && hoverGone && pop && fonts.body_latin_is_inter && fonts.serif_latin_is_literata && fonts.display_latin_is_playfair && fonts.body_cjk_is_simsun
  console.log(pass ? 'ALL PASS' : 'HAS FAIL')
  ws.close()
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
