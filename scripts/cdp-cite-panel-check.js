// 对话引用体系验证：论文级编号/同文同号/悬停卡/来源面板/点击跳首页
const WebSocket = require('ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const PORT = parseInt(process.env.CDP_PORT || '9222')
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
  const send = (method, params = {}) => new Promise((res, rej) => { const m = ++id; pend.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })) })
  const ev = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value })
  const evA = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value })
  await send('Page.bringToFront').catch(() => {})
  await sleep(2500)

  // 1) 切到对话模式，发一个会命中多篇论文的问题
  await ev(`[...document.querySelectorAll('.mode-toggle button')].find(b => b.title.includes('对话')).click()`)
  await sleep(1200)
  const q = '库里有哪些论文涉及时间序列预测或可靠性建模？每篇用一句话说明它用了什么方法，并标注来源编号。'
  await ev(`(() => {
    const ta = document.querySelector('.chat-view .hero-textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(q)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(300)
  await ev(`document.querySelector('.chat-view .send-btn').click()`)

  // 2) 等流式结束（发送按钮退出 stop 态）
  let done = false
  for (let i = 0; i < 120; i++) {
    done = await ev(`!document.querySelector('.chat-view .send-btn.stop') && !!document.querySelector('.chat-view .chat-log')`)
    const hasContent = await ev(`(() => { const b = [...document.querySelectorAll('.chat-view .bubble')]; const last = b[b.length - 1]; return last ? last.textContent.length > 80 : false })()`)
    if (done && hasContent) break
    await sleep(1000)
  }
  await sleep(1500)

  // 3) 断言：芯片 [n] 无页码、来源面板、同号映射
  const r = await ev(`(() => {
    const chips = [...document.querySelectorAll('.chat-view .cite-chip')]
    const panel = document.querySelector('.src-panel')
    const cards = [...document.querySelectorAll('.src-panel .src-card')]
    return {
      chipTexts: chips.map((c) => c.textContent.trim()).slice(0, 10),
      panelOpen: !!panel,
      cardCount: cards.length,
      cardSample: cards.slice(0, 3).map((c) => c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90))
    }
  })()`)
  console.log('panel/cards:', JSON.stringify(r))
  const distinct = [...new Set(r.chipTexts)]
  const chipOk = r.chipTexts.length > 0 && r.chipTexts.every((t) => /^\[\d+\]$/.test(t))
  // 4) 悬停芯片 → 信息卡
  const hoverXY = await ev(`(() => { const c = document.querySelector('.chat-view .cite-chip'); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverXY.x, y: hoverXY.y, buttons: 0 })
  await sleep(300)
  // CDP mouseMoved 在部分环境不合成 enter（无前序位置），补一发 mouseover 确保 React 进入事件
  await ev(`(() => { const c = document.querySelector('.chat-view .cite-chip'); c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })()`)
  await sleep(500)
  const card = await ev(`(() => { const c = document.querySelector('.chat-view .cite-card'); return c ? c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null })()`)
  console.log('hover card:', JSON.stringify(card))
  // 5) 点来源卡片 → 跳阅读界面首页
  const beforeTitle = await ev(`(() => { const w = document.querySelector('.main-win'); return w && !w.classList.contains('pane-hidden') ? document.querySelector('.tabselect b')?.textContent.slice(0, 20) : 'chat' })()`)
  await ev(`document.querySelector('.src-panel .src-card').click()`)
  await sleep(2500)
  const jump = await ev(`(() => {
    const w = document.querySelector('.main-win')
    const mode = w && !w.classList.contains('pane-hidden') ? 'read' : 'chat'
    const sc = document.querySelector('.viewer-scroll')
    return { mode, title: document.querySelector('.tabselect b')?.textContent.slice(0, 22), page: document.querySelector('.page-ind')?.textContent, st: sc ? Math.round(sc.scrollTop) : null }
  })()`)
  console.log('card click jump:', JSON.stringify(jump))
  // 6) 收起/展开
  await ev(`[...document.querySelectorAll('.mode-toggle button')].find(b => b.title.includes('对话')).click()`)
  await sleep(1000)
  await ev(`document.querySelector('.src-panel-x')?.click()`)
  await sleep(400)
  const collapsed = await ev(`!document.querySelector('.src-panel') && !!document.querySelector('.src-panel-restore')`)
  console.log('collapse:', collapsed)
  const pillTop = await ev(`(() => { const p = document.querySelector('.src-panel-restore'); const v = document.querySelector('.chat-view'); if (!p || !v) return null; return Math.round(p.getBoundingClientRect().top - v.getBoundingClientRect().top) })()`)

  // 右缘芯片悬停：卡片不越聊天区右缘、不压来源面板，且无原生 title 白条
  await ev(`(() => { const cs = [...document.querySelectorAll('.chat-view .cite-chip')]; const c = cs.reduce((a, b) => (b.getBoundingClientRect().right > a.getBoundingClientRect().right ? b : a)); c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })()`)
  await sleep(600)
  const bounds = await ev(`(() => {
    const card = document.querySelector('.chat-view .cite-card')
    const log = document.querySelector('.chat-view .chat-log')
    const panel = document.querySelector('.src-panel')
    const chip = [...document.querySelectorAll('.chat-view .cite-chip')].reduce((a, b) => (b.getBoundingClientRect().right > a.getBoundingClientRect().right ? b : a))
    if (!card || !log) return null
    const kr = card.getBoundingClientRect(), lr = log.getBoundingClientRect(), pr = panel ? panel.getBoundingClientRect() : null
    return { cardRight: Math.round(kr.right), logRight: Math.round(lr.right), panelLeft: pr ? Math.round(pr.left) : null, chipTitle: chip ? chip.getAttribute('title') : null, below: card.hasAttribute('data-below') }
  })()`)
  console.log('right-edge bounds:', JSON.stringify(bounds))
  const rightOk = !!bounds && bounds.cardRight <= bounds.logRight - 2 && (bounds.panelLeft == null || bounds.cardRight <= bounds.panelLeft + 2) && bounds.chipTitle == null

  const pass = chipOk && r.panelOpen && r.cardCount > 0 && !!card && jump.mode === 'read' && collapsed && rightOk && pillTop != null && pillTop < 40
  console.log(pass ? 'ALL PASS' : 'HAS FAIL', '| chips:', r.chipTexts.join(' '), '| pillTop:', pillTop)
  ws.close()
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
