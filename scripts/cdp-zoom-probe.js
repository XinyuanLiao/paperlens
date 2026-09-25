// CDP 实测：侧栏开合 / 窗口 resize / 标签切换时 PDF 缩放与页面尺寸是否变化
const WebSocket = require('ws')

const PORT = process.env.CDP_PORT || 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTargets() {
  for (let i = 0; i < 30; i++) {
    try {
      const [list, ver] = await Promise.all([
        fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json())
      ])
      const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
      if (page) return { pageWs: page.webSocketDebuggerUrl, browserWs: ver.webSocketDebuggerUrl, targetId: page.id }
    } catch {}
    await sleep(1000)
  }
  throw new Error('no CDP page target')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

let id = 0
const pending = new Map()
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}

async function evalJs(ws, expr, awaitPromise = false) {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}

function measureExpr() {
  return `(() => {
    const sc = document.querySelector('.viewer-scroll')
    const pg = document.querySelector('.page-wrap')
    const btns = [...document.querySelectorAll('.viewer-toolbar .seg')]
    const zoomSeg = btns.find(s => /%$/.test(s.textContent.trim()) || /%/.test(s.textContent))
    return {
      containerW: sc ? sc.clientWidth : null,
      pageW: pg ? pg.getBoundingClientRect().width : null,
      pageH: pg ? pg.getBoundingClientRect().height : null,
      zoomText: zoomSeg ? zoomSeg.textContent.trim() : null,
      scrollTop: sc ? Math.round(sc.scrollTop) : null,
      xScroll: sc ? sc.classList.contains('x-auto') : null,
      dpr: window.devicePixelRatio
    }
  })()`
}

function wire(ws) {
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  })
}

async function main() {
  const { pageWs, browserWs, targetId } = await getTargets()
  const ws = await connect(pageWs)
  wire(ws)
  const bws = await connect(browserWs)
  wire(bws)

  // 等应用就绪
  for (let i = 0; i < 30; i++) {
    const ready = await evalJs(ws, `!!document.querySelector('.paper-item')`).catch(() => false)
    if (ready) break
    await sleep(1000)
  }

  const before = await evalJs(ws, `document.querySelectorAll('.paper-item').length + ' papers, visibility=' + document.visibilityState`)
  console.log('state:', before)

  // 打开第一篇论文
  await evalJs(ws, `document.querySelector('.paper-item').click()`)
  await sleep(4000)

  console.log('--- open paper:', JSON.stringify(await evalJs(ws, measureExpr())))

  // 1) 弹出右侧问答面板（顶栏右侧 icon-btn）
  await evalJs(ws, `document.querySelector('.tb-right .icon-btn').click()`)
  await sleep(900)
  console.log('--- side ON:', JSON.stringify(await evalJs(ws, measureExpr())))

  // 2) 收起
  await evalJs(ws, `document.querySelector('.tb-right .icon-btn').click()`)
  await sleep(900)
  console.log('--- side OFF:', JSON.stringify(await evalJs(ws, measureExpr())))

  // 3) 窗口 resize（缩小 240px 宽）
  const winId = (await send(bws, 'Browser.getWindowForTarget', { targetId })).windowId
  const bounds0 = (await send(bws, 'Browser.getWindowBounds', { windowId: winId })).bounds
  await send(bws, 'Browser.setWindowBounds', { windowId: winId, bounds: { width: bounds0.width - 240, height: bounds0.height } })
  await sleep(900)
  console.log('--- window narrower:', JSON.stringify(await evalJs(ws, measureExpr())))

  // 4) 还原窗口
  await send(bws, 'Browser.setWindowBounds', { windowId: winId, bounds: { width: bounds0.width, height: bounds0.height } })
  await sleep(900)
  console.log('--- window restored:', JSON.stringify(await evalJs(ws, measureExpr())))

  // 5) 显式 zoom 到 150%（ctrl+wheel 等价：调用 toolbar + 按钮）
  await evalJs(ws, `[...document.querySelectorAll('.viewer-toolbar .seg button')].at(-1).click()`)
  await sleep(300)
  await evalJs(ws, `[...document.querySelectorAll('.viewer-toolbar .seg button')].at(-1).click()`)
  await sleep(300)
  await evalJs(ws, `[...document.querySelectorAll('.viewer-toolbar .seg button')].at(-1).click()`)
  await sleep(600)
  console.log('--- zoomed +3:', JSON.stringify(await evalJs(ws, measureExpr())))

  // 6) 再开合侧栏（zoom=1.45 时）
  await evalJs(ws, `document.querySelector('.tb-right .icon-btn').click()`)
  await sleep(900)
  console.log('--- zoomed, side ON:', JSON.stringify(await evalJs(ws, measureExpr())))
  await evalJs(ws, `document.querySelector('.tb-right .icon-btn').click()`)
  await sleep(900)
  console.log('--- zoomed, side OFF:', JSON.stringify(await evalJs(ws, measureExpr())))

  // 7) 打开第二篇再切回（标签切换 refit 场景）
  const n = await evalJs(ws, `document.querySelectorAll('.paper-item').length`)
  if (n > 1) {
    await evalJs(ws, `document.querySelectorAll('.paper-item')[1].click()`)
    await sleep(4000)
    console.log('--- open 2nd paper:', JSON.stringify(await evalJs(ws, measureExpr())))
    await evalJs(ws, `document.querySelectorAll('.tabselect-item')[0] ? document.querySelectorAll('.tabselect-item')[0].click() : document.querySelector('.tabselect').click()`)
    await sleep(2500)
    console.log('--- back to 1st:', JSON.stringify(await evalJs(ws, measureExpr())))
  }

  ws.close()
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
