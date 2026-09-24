// CDP 冒烟：RAG 全链路（提问 → 流式回答 → 来源芯片 → 校验条）
// 用法：NODE_PATH=<repo>/node_modules node scripts/cdp-rag-smoke.js [9222]
const WebSocket = require('ws')

const PORT = process.argv[2] || '9222'

async function main() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page' && t.title.includes('PaperLens')) ?? list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target: ' + JSON.stringify(list.map((t) => t.title)))
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((res, rej) => (ws.on('open', res).on('error', rej)))
  let seq = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result?.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 1. 等待应用就绪（文件树渲染）
  for (let i = 0; i < 30; i++) {
    const ready = await evalJs(`!!document.querySelector('.view-toggle, .chat-view, .side') && document.visibilityState`)
    if (ready && ready !== 'hidden') break
    await sleep(1000)
  }
  console.log('visibility:', await evalJs('document.visibilityState'))

  // 2. 切到对话模式（顶部分段切换）
  await evalJs(`(() => { const seg = [...document.querySelectorAll('.view-toggle .seg span, .view-toggle span')]; const chat = seg.find(s => /对话/.test(s.textContent)); if (chat) chat.click(); return seg.length })()`)

  // 3. 等待输入框，输入问题并发送
  await sleep(600)
  const typed = await evalJs(`(() => {
    const ta = document.querySelector('.chat-view .hero-textarea')
    if (!ta) return 'NO_TEXTAREA'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    ta._v = 'power module 的主要失效机理有哪些？哪些文献讨论了 bond wire 失效？'
    if (ta.value === ta._v) ta._v = ta._v + ' '
    setter.call(ta, ta._v)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return ta.value.length
  })()`)
  console.log('typed:', typed)
  await sleep(300)
  await evalJs(`document.querySelector('.chat-view .send-btn')?.click()`)

  // 4. 轮询等待回答完成（busy 消失 + 校验条出现）
  let last = ''
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    const st = await evalJs(`(() => {
      const txt = document.querySelector('.chat-view .chat-log')?.innerText || ''
      const verify = [...document.querySelectorAll('.chat-view .verify-bar')].map(v => v.innerText.replace(/\\n/g,' | '))
      const chips = [...document.querySelectorAll('.chat-view .cite-chip')].map(c => c.textContent.trim())
      const busy = !!document.querySelector('.chat-view .send-btn.stop')
      return JSON.stringify({ len: txt.length, verify, chips: chips.length, busy, tail: txt.slice(-160) })
    })()`)
    const s = JSON.parse(st)
    if (s.len !== last.length || true) last = s.tail
    if (!s.busy && s.len > 200 && (i > 8 || s.verify.length)) {
      console.log('answer len:', s.len, '| chips:', s.chips, '| verify:', s.verify)
      console.log('tail:', s.tail.replace(/\n/g, ' ').slice(0, 150))
      if (s.verify.length || i > 30) {
        console.log(s.verify.length ? 'VERIFY_BAR_OK' : 'NO_VERIFY_BAR (timeout)')
        break
      }
    }
    if (i % 10 === 9) console.log(`…waiting ${i + 1}s busy=${s.busy} len=${s.len}`)
  }

  // 5. 校验条点击展开
  const expanded = await evalJs(`(() => {
    const t = document.querySelector('.chat-view .verify-toggle')
    if (!t) return 'NO_TOGGLE'
    t.click()
    return document.querySelector('.chat-view .verify-issues')?.innerText?.slice(0, 300) ?? 'no issues dom'
  })()`)
  console.log('expanded issues:', expanded)

  // 6. 引用芯片 title（章节信息）
  const titles = await evalJs(`[...document.querySelectorAll('.chat-view .cite-chip')].slice(0,3).map(c => c.getAttribute('title'))`)
  console.log('chip titles:', titles)
  ws.close()
}
main().catch((e) => {
  console.error('SMOKE FAIL:', e)
  process.exit(1)
})
