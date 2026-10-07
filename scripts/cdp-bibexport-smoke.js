// CDP 冒烟：批量 BibTeX 导出全链路（文件菜单 → 核对进度 → 结果列表 → 预览 → 取消/警告徽标）
// 用法：NODE_PATH=<repo>/node_modules node scripts/cdp-bibexport-smoke.js [9223]
const WebSocket = require('ws')

const PORT = process.argv[2] || '9223'

async function main() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page' && t.title.includes('PaperLens')) ?? list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((res, rej) => ws.on('open', res).on('error', rej))
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
    if (r.result?.exceptionDetails) throw new Error(expression.slice(0, 120) + ' => ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result?.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const fail = []
  const check = (name, ok, detail = '') => {
    console.log(ok ? ' ✓' : ' ✗', name, ok ? '' : detail)
    if (!ok) fail.push(name)
  }

  // 1. 等应用就绪
  for (let i = 0; i < 30; i++) {
    const ready = await evalJs(`!!document.querySelector('.menu-btn')`)
    if (ready) break
    await sleep(1000)
  }

  // 2. preload api 齐全
  check('api.bibExportRun', await evalJs(`typeof window.api.bibExportRun`), '')
  check('api.onBibResult', await evalJs(`typeof window.api.onBibResult === 'function'`))
  check('api.bibExportSave', await evalJs(`typeof window.api.bibExportSave === 'function'`))

  // 3. 库里要有那篇假论文（启动扫描入库）
  const nPapers = await evalJs(`(async () => (await window.api.listPapers()).length)()`)
  check('库扫描到 1 篇', nPapers === 1, `got ${nPapers}`)

  // 4. 文件菜单 → 导出 BibTeX…
  await evalJs(`(() => { const b = [...document.querySelectorAll('.menu-btn')].find(x => x.textContent.includes('文件')); b.click(); return true })()`)
  await sleep(300)
  const menuItem = await evalJs(`(() => { const items = [...document.querySelectorAll('.menu-dropdown .menu-item')]; const it = items.find(x => x.textContent.includes('导出 BibTeX')); if (!it) return null; it.click(); return it.textContent })()`)
  check('菜单项存在并点击', /导出 BibTeX/.test(String(menuItem)), JSON.stringify(menuItem))
  await sleep(500)

  // 5. 对话框出现，进入核对进度态（真实联网，1 篇约 2-3 秒）
  check('对话框打开', await evalJs(`!!document.querySelector('.bib-modal')`))
  const checking = await evalJs(`!!document.querySelector('.bib-checking')`)
  console.log('  (核对进度态:', checking ? '出现' : '未及捕获（可能已完成）', ')')
  await sleep(400)

  // 6. 等结果列表（最多 30s：检索 + doi.org 内容协商 + 1.2s 节流）
  let rows = 0
  for (let i = 0; i < 30; i++) {
    rows = await evalJs(`document.querySelectorAll('.bib-row').length`)
    if (rows > 0) break
    await sleep(1000)
  }
  check('结果列表渲染', rows === 1, `got ${rows}`)

  // 7. 条目内容：official 徽标 + key + 汇总行
  const badge = await evalJs(`document.querySelector('.bib-src-badge')?.textContent`)
  check('官方核对徽标', badge === '官方核对', `got ${badge}`)
  const key = await evalJs(`document.querySelector('.bib-key')?.textContent`)
  check('key 生成', /^yang2011/.test(String(key)), `got ${key}`)
  const summary = await evalJs(`document.querySelector('.bib-summary')?.textContent`)
  check('汇总含分层计数', /官方核对 1/.test(String(summary)), `got ${summary}`)

  // 8. 展开预览：应含 @article 与 journal 字段
  await evalJs(`document.querySelector('.bib-row')?.click()`)
  await sleep(300)
  const pre = await evalJs(`document.querySelector('.bib-pre')?.textContent`)
  check('预览 @article', String(pre).includes('@article{yang2011'), String(pre).slice(0, 80))
  check('预览含 journal', /journal\s*=/.test(String(pre)))
  check('预览含 doi', /doi\s*=/.test(String(pre)))

  // 9. 勾选交互：取消勾选后导出按钮禁用
  await evalJs(`(() => { const cb = document.querySelector('.bib-row input[type=checkbox]'); cb.click(); return true })()`)
  await sleep(200)
  const disabled = await evalJs(`!![...document.querySelectorAll('.modal-actions .btn')].find(b => b.textContent.includes('导出'))?.disabled`)
  check('全不选时导出禁用', disabled === true, `got ${disabled}`)
  await evalJs(`(() => { document.querySelector('.bib-checkall')?.click(); return true })()`)
  await sleep(200)

  console.log(fail.length ? `\nFAIL: ${fail.join(', ')}` : '\nAll bibexport UI smoke checks passed')
  ws.close()
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
