// CDP：触发重建索引并轮询进度（marker 路径验证）
const WebSocket = require('ws')
const PORT = process.argv[2] || '9222'

async function main() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
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
    return r.result?.result?.value
  }
  const r = await evalJs(`window.api.rebuildIndex()`)
  console.log('rebuild triggered:', r)
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 10000))
    const st = await evalJs(`window.api.indexStatus()`)
    console.log(JSON.stringify(st))
    if (st && !st.running) break
  }
  ws.close()
}
main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
