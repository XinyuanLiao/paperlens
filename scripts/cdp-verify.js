// CDP 综合验证：测试嵌入（bge-m3 本地加载）→ 触发全库重建并轮询 → 测试重排序（设备报告）
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
    return r.result?.result?.value ?? JSON.stringify(r.result?.exceptionDetails ?? '').slice(0, 300)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  console.log('testEmbed:', await evalJs(`window.api.testEmbed()`))
  console.log('rebuild:', await evalJs(`window.api.rebuildIndex()`))
  for (let i = 0; i < 90; i++) {
    await sleep(10000)
    const st = await evalJs(`window.api.indexStatus()`)
    console.log(i * 10 + 10 + 's', JSON.stringify(st))
    if (st && !st.running && st.indexed === st.papers && st.papers > 0) break
  }
  console.log('testRerank:', await evalJs(`window.api.testRerank()`))
  ws.close()
}
main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
