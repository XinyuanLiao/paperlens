// LLM 请求层回归（由 test-llm-stub.mjs 打包并启动，不单独运行）。
//
// 本地桩服务按各家「OpenAI 兼容」接口的真实规矩挑刺，在真实 Electron（Chromium 网络栈 net.fetch）
// 里跑 src/main/llm.ts，断言请求体与报错文案：
//   - 现役 Kimi 模型拒绝 temperature、K3 不认 thinking、K2.6 不认 reasoning_effort（官方「模型参数参考」）
//   - 已下线模型 404；200 的流里夹错误事件；只思考不作答；输出被截断；内容审查拦截；连接挂起
//   - 非推理模型不认 reasoning_effort；通义非流式不支持思考开关；参数被拒后的逐组剥离与记忆
//   - Kimi Code 订阅端点、Key 错误、地址路径不对、连接被拒绝
//   - 启动时把老配置里的下线模型迁移为现役模型
const { app, net } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const RESULT = process.env.PL_LLM_RESULT
const BUNDLE = process.env.PL_LLM_BUNDLE
if (!RESULT || !BUNDLE) {
  console.error('请通过 scripts/test-llm-stub.mjs 运行')
  app.exit(2)
}

// 独立数据目录：不碰真实配置
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-llm-stub-'))
app.setPath('userData', path.join(tmp, 'userData'))
app.disableHardwareAcceleration()

// ---------- 桩服务 ----------
const log = [] // 每个入站请求：{ kind, prefix, auth, body }
const RETIRED = ['kimi-k2-0711-preview', 'kimi-latest', 'moonshot-v1-128k']

const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}
// 分块写出并留间隔：检验流式的增量解析与跨块半行缓存
const writeChunks = (res, parts, done) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  let i = 0
  const step = () => {
    if (i >= parts.length) return done()
    res.write(parts[i++])
    setTimeout(step, 8)
  }
  step()
}
const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
const first = ev({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
const reason = (t) => ev({ choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }] })
const text = (t, fin = null) => ev({ choices: [{ index: 0, delta: t ? { content: t } : {}, finish_reason: fin }] })
const DONE = 'data: [DONE]\n\n'

const prefixOf = (p) =>
  p.startsWith('/kimi/v1/')
    ? 'kimi'
    : p.startsWith('/openai/v1/')
      ? 'openai'
      : p.startsWith('/zhipu/v1/')
        ? 'zhipu'
        : p.startsWith('/qwen/v1/')
          ? 'qwen'
          : p === '/v1/chat/completions' || p === '/v1/models'
            ? 'custom'
            : ''

function onReq(req, res, raw) {
  const p = req.url.split('?')[0]
  const prefix = prefixOf(p)
  const auth = req.headers.authorization
  if (p.endsWith('/models')) {
    log.push({ kind: 'models', prefix, auth })
    if (prefix !== 'kimi' && prefix !== 'custom') return json(res, 404, { error: { message: 'Not Found', type: 'not_found_error' } })
    if (auth !== 'Bearer sk-test') return json(res, 401, { error: { message: 'Incorrect API key provided', type: 'incorrect_api_key_error' } })
    return json(res, 200, { object: 'list', data: [{ id: 'kimi-k3.1-pro' }, { id: 'kimi-k3' }, { id: 'kimi-k3.1-pro-highspeed' }] })
  }
  if (!prefix || !p.endsWith('/chat/completions')) {
    log.push({ kind: 'miss', path: p })
    res.writeHead(404, { 'Content-Type': 'text/html' })
    return res.end('<html><body><h1>404 Not Found</h1></body></html>')
  }
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {
    /* 非 JSON 请求体按空处理 */
  }
  log.push({ kind: 'chat', prefix, auth, body })
  if (body.model === 'hang') return // 永不响应：验证首字节超时
  if (auth !== 'Bearer sk-test') return json(res, 401, { error: { message: 'Incorrect API key provided', type: 'incorrect_api_key_error' } })

  const m = String(body.model ?? '')
  const bad = (message, type = 'invalid_request_error') => json(res, 400, { error: { message, type } })
  if (prefix === 'kimi') {
    if (RETIRED.includes(m)) return json(res, 404, { error: { message: 'The model does not exist or you do not have access to it.', type: 'resource_not_found_error' } })
    if (body.temperature !== undefined) return bad('temperature is fixed for this model; passing other values returns an error')
    if (m.startsWith('kimi-k3') && body.thinking !== undefined) return bad('The K3 series does not support the `thinking` parameter')
    if (m.startsWith('kimi-k2.6') && body.reasoning_effort !== undefined) return bad('`reasoning_effort` is not supported for kimi-k2.6')
    // 演练：假设将来的 K3 也不再认 reasoning_effort——验证「被拒即剥离重试」这条兜底
    if (m === 'kimi-k3-future' && body.reasoning_effort !== undefined) return bad('`reasoning_effort` is no longer supported for this model')
  } else if (prefix === 'openai') {
    if (/^(o\d|gpt-5)/.test(m)) {
      if (body.temperature !== undefined) return bad("Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported.")
    } else if (body.reasoning_effort !== undefined) return bad('Unrecognized request argument supplied: reasoning_effort')
  } else if (prefix === 'zhipu') {
    // 旧式 GLM 接口对不认的参数一律报 1214「参数非法」
    if (m === 'glm-4.5-strict') {
      if (body.temperature !== undefined) return bad('1214: 参数非法。请检查文档。')
      if (body.thinking !== undefined) return bad('1214: 参数非法，不支持 thinking 参数。请检查文档。')
    }
    if (m === 'glm-4-plus' && body.thinking !== undefined) return bad('1214: 参数非法。请检查文档。')
  } else if (prefix === 'qwen') {
    if (body.enable_thinking !== undefined && !body.stream) return bad('enable_thinking only support stream call')
  } else if (m === 'temp-strict' && body.temperature !== undefined) {
    return bad("Unsupported value: 'temperature' does not support 0.3 with this model.")
  }

  const ask = String(body.messages?.[body.messages.length - 1]?.content ?? '')
  if (!body.stream) {
    return json(res, 200, {
      id: 'c1',
      object: 'chat.completion',
      model: m,
      choices: [{ index: 0, message: { role: 'assistant', content: '你好！世界。', reasoning_content: '想一想' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
    })
  }
  const think = [reason('先理解问题。'), reason('再组织语言。')]
  if (ask.includes('[[stream-error]]')) return writeChunks(res, [first, text('这是'), ev({ error: { code: '1302', message: '您当前使用该 API 的并发数过高，请降低并发' } })], () => res.end())
  if (ask.includes('[[empty-thinker]]')) return writeChunks(res, [first, ...think, text('', 'length'), DONE], () => res.end())
  if (ask.includes('[[truncated]]')) return writeChunks(res, [first, ...think, text('写到一'), text('半'), text('', 'length'), DONE], () => res.end())
  if (ask.includes('[[filtered]]')) return writeChunks(res, [first, text('部分内容'), text('', 'content_filter'), DONE], () => res.end())
  // 默认：先推理后作答；把其中一行从中间劈开分两次写，检验跨块的半行缓存
  const line = text('！世界') // text() 已是完整的 data: 事件
  const half = line.slice(0, Math.floor(line.length / 2))
  writeChunks(res, [first, ...think, text('你好'), half, line.slice(half.length), text('。'), text('', 'stop'), DONE], () => res.end())
}
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => onReq(req, res, raw))
})

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const mod = await import('file://' + BUNDLE)
  const { db, llm, http: httpMod, providers } = mod

  // 各家真实域名改道到本地桩：请求体按真实地址判定服务商类型来构造，只有传输被改道
  const route = [
    ['https://api.openai.com/v1', `${base}/openai/v1`],
    ['https://open.bigmodel.cn/api/paas/v4', `${base}/zhipu/v1`],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', `${base}/qwen/v1`],
    ['https://api.moonshot.cn/v1', `${base}/kimi/v1`],
    ['https://api.moonshot.cn/v2', `${base}/kimi-bad/v2`]
  ]
  httpMod.setHttpFetch(async (url, init) => {
    const hit = route.find(([from]) => url.startsWith(from))
    const resp = await net.fetch(hit ? hit[1] + url.slice(hit[0].length) : url, init)
    if (!process.env.PL_LLM_DEBUG) return resp
    // 调试：把响应体的原始分块打印出来（不经解析）
    const [a, b] = resp.body.tee()
    ;(async () => {
      const rd = a.getReader()
      for (;;) {
        const { done, value } = await rd.read()
        if (done) break
        console.log('   RAW', value.length, JSON.stringify(new TextDecoder().decode(value)))
      }
    })()
    return new Response(b, { status: resp.status, headers: resp.headers })
  })
  db.initDb()

  const results = []
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: ok ? undefined : detail })
    console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ←  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
  const chats = () => log.filter((e) => e.kind === 'chat')
  const lastBody = () => chats().at(-1)?.body ?? {}
  const stream = async (content = 'hi', opts = {}) => {
    const out = { text: '', reason: '', finish: '' }
    try {
      for await (const t of llm.chatStream([{ role: 'user', content }], { onReason: (r) => (out.reason += r), onFinish: (f) => (out.finish = f), ...opts })) out.text += t
    } catch (e) {
      out.error = e.message
    }
    return out
  }
  const once = async (content = 'hi') => {
    try {
      return { reply: (await llm.chatOnce([{ role: 'user', content }])).reply }
    } catch (e) {
      return { error: e.message }
    }
  }
  let r
  let n0
  let r1

  // ---------- Kimi 现役模型 ----------
  const KIMI = { apiBase: 'https://api.moonshot.cn/v1', apiKey: 'sk-test', provider: 'moonshot', thinkingLevel: 'on' }
  db.saveSettings({ ...KIMI, model: 'kimi-k3.1-pro' })
  r = await stream()
  check('K3 流式：跨块半行也能拼出完整正文', r.text === '你好！世界。' && !r.error, r)
  check('K3 流式：推理片段走 onReason，不混进正文', r.reason === '先理解问题。再组织语言。', r)
  check('K3 流式：回传 finish_reason', r.finish === 'stop', r)
  check('K3 请求体：不发 temperature（旧版每次都发 0.3，必被拒）', !('temperature' in lastBody()), lastBody())
  check('K3 请求体：不发 thinking（K3 不认）', !('thinking' in lastBody()), lastBody())
  check('K3 请求体：reasoning_effort=high', lastBody().reasoning_effort === 'high', lastBody())
  check('K3：一次成功，没有降级重试', chats().length === 1, chats().length)
  check('K3 请求头：Bearer Key', log[0].auth === 'Bearer sk-test', log[0])
  db.saveSettings({ thinkingLevel: 'off' })
  await stream()
  check('K3 关闭思考：reasoning_effort=low', lastBody().reasoning_effort === 'low', lastBody())
  db.saveSettings({ thinkingLevel: 'on' })
  r = await once()
  check('K3 非流式：读到正文', r.reply === '你好！世界。', r)
  check('K3 非流式：同样不带 temperature', !('temperature' in lastBody()), lastBody())

  db.saveSettings({ model: 'kimi-k2.6' })
  await stream()
  check('K2.6：用 thinking.type=enabled，不发 reasoning_effort / temperature', lastBody().thinking?.type === 'enabled' && !('reasoning_effort' in lastBody()) && !('temperature' in lastBody()), lastBody())
  db.saveSettings({ thinkingLevel: 'off' })
  await stream()
  check('K2.6 关闭思考：thinking.type=disabled', lastBody().thinking?.type === 'disabled', lastBody())
  db.saveSettings({ model: 'kimi-k2.7-code', thinkingLevel: 'on' })
  await stream()
  check('K2.7-code：始终思考，不下发思考参数', !('thinking' in lastBody()) && !('reasoning_effort' in lastBody()), lastBody())

  // ---------- 已下线模型 / Key 错误 ----------
  db.saveSettings({ model: 'kimi-k2-0711-preview' })
  r = await once()
  check('已下线模型：报错点名模型并指向「同步模型」', /「kimi-k2-0711-preview」不存在或已下线/.test(r.error ?? '') && /同步模型/.test(r.error ?? ''), r)
  r = await stream()
  check('已下线模型（流式）：同样给出明确报错、不产出正文', /不存在或已下线/.test(r.error ?? '') && r.text === '', r)
  db.saveSettings({ model: 'kimi-k3.1-pro', apiKey: 'sk-wrong' })
  r = await once()
  check('Key 错误：提示 Key 无效 + 国内/国际站不通用', /API Key 无效/.test(r.error ?? '') && /不通用/.test(r.error ?? ''), r)
  db.saveSettings({ apiKey: '  sk-test  ' })
  r = await once()
  check('Key 带首尾空白（粘贴常见）：自动去空白后可用', r.reply === '你好！世界。', r)
  db.saveSettings({ apiKey: '' })
  r = await stream()
  check('未配置 Key：流式给出指引文字而不是抛错', /尚未配置 API Key/.test(r.text) && !r.error, r)
  r = await once()
  check('未配置 Key：非流式明确报错', /未配置 API Key/.test(r.error ?? ''), r)
  db.saveSettings({ apiKey: 'sk-test' })

  // ---------- 流的异常结束 ----------
  r = await stream('[[stream-error]]')
  check('流内错误：不静默截断，报出服务商原话', /服务商中断了响应/.test(r.error ?? '') && /并发数过高/.test(r.error ?? ''), r)
  r = await stream('[[empty-thinker]]')
  check('只思考不作答：正文为空、finish=length', r.text === '' && r.finish === 'length' && !r.error, r)
  check('只思考不作答：提示语说明原因', /没有返回内容/.test(llm.finishNote(r.finish, r.text)), llm.finishNote(r.finish, r.text))
  r = await stream('[[truncated]]')
  check('输出被截断：已到正文保留、finish=length', r.text === '写到一半' && r.finish === 'length' && !r.error, r)
  check('输出被截断：提示语追加在正文后', /^> ⚠️ 回答达到输出长度上限/.test(llm.finishNote(r.finish, r.text).trim()), llm.finishNote(r.finish, r.text))
  r = await stream('[[filtered]]')
  check('内容审查拦截：finish=content_filter', r.finish === 'content_filter' && r.text === '部分内容', r)
  check('内容审查拦截：提示语说明被中断', /内容审查中断/.test(llm.finishNote(r.finish, r.text)), llm.finishNote(r.finish, r.text))
  check('正常结束：不追加任何提示', llm.finishNote('stop', '好的。') === '', '')

  // ---------- 参数被拒 → 逐组剥离重试 ----------
  db.saveSettings({ model: 'kimi-k3-future' })
  n0 = chats().length
  r = await stream()
  check('参数被拒：自动剥离后重试成功，正文完整', r.text === '你好！世界。' && !r.error, r)
  check('参数被拒：共两次请求（被拒一次 + 重试一次）', chats().length - n0 === 2, chats().length - n0)
  n0 = chats().length
  await stream()
  check('记住结论：下次直接不发被拒的参数，一次成功', chats().length - n0 === 1 && !('reasoning_effort' in lastBody()), lastBody())

  db.saveSettings({ apiBase: 'https://api.openai.com/v1', provider: 'openai', model: 'gpt-4o-mini' })
  n0 = chats().length
  r = await stream()
  check('OpenAI gpt-4o-mini：带 temperature、不带 reasoning_effort（旧版会带上而被拒）', 'temperature' in lastBody() && !('reasoning_effort' in lastBody()) && !r.error && chats().length - n0 === 1, { body: lastBody(), n: chats().length - n0, error: r.error })
  db.saveSettings({ model: 'o4-mini' })
  n0 = chats().length
  r = await stream()
  check('OpenAI o4-mini：不发 temperature，reasoning_effort=medium', !('temperature' in lastBody()) && lastBody().reasoning_effort === 'medium' && !r.error && chats().length - n0 === 1, { body: lastBody(), n: chats().length - n0 })

  db.saveSettings({ apiBase: 'https://open.bigmodel.cn/api/paas/v4', provider: 'zhipu', model: 'glm-4.5-strict' })
  n0 = chats().length
  r = await stream()
  check('GLM 两组参数都被拒：逐组剥离，第三次成功', !r.error && chats().length - n0 === 3 && !('temperature' in lastBody()) && !('thinking' in lastBody()), { n: chats().length - n0, body: lastBody(), error: r.error })
  db.saveSettings({ model: 'glm-4-plus' })
  n0 = chats().length
  r = await stream()
  check('上一代 GLM（glm-4-plus）：不下发 thinking，一次成功', !('thinking' in lastBody()) && !r.error && chats().length - n0 === 1, { body: lastBody(), n: chats().length - n0 })
  db.saveSettings({ model: 'glm-4.5-air' })
  await stream()
  check('GLM-4.5+：thinking.type=enabled', lastBody().thinking?.type === 'enabled', lastBody())

  db.saveSettings({ apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', provider: 'qwen', model: 'qwen-plus' })
  n0 = chats().length
  r = await once()
  check('通义非流式：不带 enable_thinking（带上会被拒）', !('enable_thinking' in lastBody()) && !r.error && chats().length - n0 === 1, { body: lastBody(), n: chats().length - n0, error: r.error })
  await stream()
  check('通义流式：enable_thinking=true', lastBody().enable_thinking === true, lastBody())

  db.saveSettings({ apiBase: `${base}/v1`, provider: 'custom', model: 'temp-strict' })
  n0 = chats().length
  r = await stream()
  check('自定义服务拒绝 temperature：剥离后重试成功', !r.error && chats().length - n0 === 2, { n: chats().length - n0, error: r.error })

  // ---------- 端点 / 网络 ----------
  n0 = log.length
  db.saveSettings({ apiBase: 'https://api.kimi.com/v1', provider: 'moonshot', model: 'kimi-k2-0905-preview' })
  r = await once()
  check('Kimi Code 订阅端点：不发请求，直接说明仅限编程工具', /Kimi Code 订阅端点/.test(r.error ?? '') && log.length === n0, r)
  db.saveSettings({ apiBase: 'https://api.moonshot.cn/v2', model: 'kimi-k3' })
  r = await once()
  check('API Base 路径不对（网关回 HTML 404）：提示检查地址，不把 HTML 甩给用户', /接口地址不存在/.test(r.error ?? '') && !/</.test(r.error ?? ''), r)
  const probe = http.createServer()
  await new Promise((res) => probe.listen(0, '127.0.0.1', res))
  const closedPort = probe.address().port
  await new Promise((res) => probe.close(res))
  db.saveSettings({ apiBase: `http://127.0.0.1:${closedPort}/v1`, provider: 'custom', model: 'm' })
  r = await once()
  check('连接被拒绝：给出原因与排查方向', /无法连接/.test(r.error ?? '') && /连接被拒绝/.test(r.error ?? ''), r)
  db.saveSettings({ apiBase: `${base}/v1`, model: 'hang' })
  const savedTimeouts = { ...llm.LLM_TIMEOUTS }
  Object.assign(llm.LLM_TIMEOUTS, { firstByteMs: 300, nonStreamMs: 300 })
  const t0 = Date.now()
  r = await stream()
  check('连接挂起（流式）：超时并明确报错，不无限等待', /超时/.test(r.error ?? '') && Date.now() - t0 < 5000, r)
  r = await once()
  check('连接挂起（非流式）：同样超时报错', /超时/.test(r.error ?? ''), r)
  Object.assign(llm.LLM_TIMEOUTS, savedTimeouts)

  db.saveSettings({ ...KIMI, model: 'kimi-k3.1-pro' })
  const ac = new AbortController()
  const it = llm.chatStream([{ role: 'user', content: 'hi' }], { signal: ac.signal })
  const head = await it.next()
  ac.abort()
  let tail = ''
  for (;;) {
    const nx = await it.next().catch((e) => ({ error: e }))
    if (nx.done || nx.error) break
    tail += nx.value
  }
  check('停止生成：中断后不再产出内容', head.value === '你好' && tail === '', { head: head.value, tail })

  // ---------- 连接测试 / 同步模型 ----------
  const t = await llm.testLLM()
  check('连接测试：通过并回报模型名与耗时', t.ok && t.model === 'kimi-k3.1-pro' && typeof t.latencyMs === 'number', t)
  const lm = await llm.listModels()
  check('同步模型：返回去重排序后的列表', lm.ok && lm.models.join(',') === 'kimi-k3,kimi-k3.1-pro,kimi-k3.1-pro-highspeed', lm)
  db.saveSettings({ apiKey: 'sk-wrong' })
  r1 = await llm.listModels()
  check('同步模型：Key 错误时给出报错', !r1.ok && /API Key 无效/.test(r1.error), r1)
  db.saveSettings({ apiBase: 'https://open.bigmodel.cn/api/paas/v4', provider: 'zhipu', apiKey: 'sk-test', model: 'glm-4.5-air' })
  r1 = await llm.listModels()
  check('同步模型：服务商无此接口时提示手动填写', !r1.ok && /手动填写/.test(r1.error), r1)

  // ---------- 启动迁移：老配置里的下线模型 ----------
  const old = {
    ...db.getSettings(),
    ...KIMI,
    model: 'kimi-k2-0711-preview',
    models: ['kimi-k2-0711-preview'],
    profiles: [{ provider: 'moonshot', apiBase: KIMI.apiBase, apiKey: 'sk-test', models: ['kimi-k2-0711-preview', 'kimi-latest'] }]
  }
  db.getDb().prepare("UPDATE meta SET value=? WHERE key='settings'").run(JSON.stringify(old))
  db.initDb()
  const now = db.getSettings()
  check('启动迁移：initDb 把老配置里的下线模型换成现役模型', now.model === 'kimi-k3.1-pro' && now.profiles?.[0]?.models.join(',') === 'kimi-k3.1-pro,kimi-k3.1-pro-highspeed,kimi-k3', { model: now.model, models: now.profiles?.[0]?.models })
  const again = providers.migrateRetiredModels(now)
  check('启动迁移：幂等，第二次不再改动', again === now, '')
  const s2 = providers.migrateRetiredModels({ apiBase: KIMI.apiBase, profiles: [{ apiBase: KIMI.apiBase, models: ['kimi-k2-0711-preview', 'kimi-k2.6'] }], model: 'kimi-k2-0711-preview' })
  check('迁移：部分下线 → 只剔下线的，默认落到剩下的首个', s2.profiles[0].models.join(',') === 'kimi-k2.6' && s2.model === 'kimi-k2.6', s2)
  const relay = { apiBase: 'https://relay.example.com/v1', provider: 'custom', model: 'kimi-latest', profiles: [{ apiBase: 'https://relay.example.com/v1', models: ['kimi-latest'] }] }
  check('迁移：中转站上的同名模型不动（可能仍在提供）', providers.migrateRetiredModels(relay) === relay, '')
  const flat = providers.migrateRetiredModels({ apiBase: KIMI.apiBase, model: 'kimi-latest', models: ['kimi-latest', 'moonshot-v1-8k'] })
  check('迁移：老式扁平配置同样覆盖', flat.model === 'kimi-k3.1-pro' && flat.models.length === 3, flat)

  // ---------- JSON 宽容解析 ----------
  check('JSON 宽容解析：```json 围栏', JSON.stringify(llm.parseJsonLoose('```json\n{"a":1}\n```')) === '{"a":1}', '')
  check('JSON 宽容解析：前后带寒暄', llm.parseJsonLoose('好的，结果如下：\n{"intent":"exact","query":"x"}\n请查收。')?.query === 'x', '')
  check('JSON 宽容解析：不是 JSON 返回 null', llm.parseJsonLoose('抱歉我不知道') === null, '')

  const failed = results.filter((x) => !x.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
  fs.writeFileSync(RESULT, JSON.stringify(results))
  server.close()
  app.exit(failed.length ? 1 : 0)
})
  .catch((e) => {
    // 运行器自身出错也必须以失败收场并留下记录，否则启动器读不到结果会误判通过
    console.error('FAIL（运行器异常）:', e)
    try {
      fs.writeFileSync(RESULT, JSON.stringify([{ name: '运行器异常', ok: false, detail: String(e?.stack ?? e) }]))
    } catch {
      /* 写不出结果文件也只能退出 */
    }
    app.exit(1)
  })
