// 点击扩展图标时弹出的小窗：识别当前标签页上的论文 → 选分类 → 保存到 PaperLens。
//
// 页面元数据的提取靠 chrome.scripting 往当前标签页注入 extract.js：只需要 activeTab 权限
//（用户点图标打开本窗时自动获得），不必一开始就要「读取所有网站数据」。
// 只有保存时为了带着登录状态下载 PDF，才按站点申请访问权限（每个站点只问一次）。

const $main = document.getElementById('main')
const $status = document.getElementById('status')
const AI_AUTO = '__auto__'

const send = (type, extra) => new Promise((resolve) => chrome.runtime.sendMessage({ type, ...extra }, resolve))

// 当前标签页是不是直接打开的 PDF（Chrome 内置查看器上没法注入脚本，按地址判断）
const isPdfTab = (url) => /\.pdf(?:$|[?#])/i.test(url || '')
// 看起来像论文标题而不是文件名（"1234-5678" / "main" 这类交给应用按文件名 / AI 识别）
const looksLikeTitle = (t) => !!t && t.length >= 15 && /[A-Za-z\u4e00-\u9fff]{2,}[\s]+[A-Za-z\u4e00-\u9fff]{2,}/.test(t)

// 页面文字一律用 textContent 放进去，不拼进 innerHTML：标题、作者来自网页，不能当 HTML 用
function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}
function setText(root, selector, text) {
  const n = root.querySelector(selector)
  if (n) n.textContent = text || ''
  return root
}
function setStatus(text, kind) {
  $status.textContent = text
  $status.className = 'status' + (kind ? ' ' + kind : '')
}
function box(title, text, extraClass) {
  return setText(setText(el(`<div class="box ${extraClass || ''}">${title ? '<div class="box-title"></div>' : ''}<div class="box-text"></div></div>`), '.box-title', title), '.box-text', text)
}

async function extract(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] })
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.__paperLensExtract ? window.__paperLensExtract() : null)
    })
    return result || null
  } catch (e) {
    return null // 浏览器自带的页面、扩展商店等不允许注入
  }
}

// 分类下拉：未分类 /（应用配了模型时）AI 自动归类 / 库里现有的分类。
// remembered 是上次保存时选的；它不在候选里（比如那个分类被删了）就用应用的默认分类
function categorySelect(info, remembered) {
  const s = document.createElement('select')
  s.className = 'select'
  const add = (value, label) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    s.appendChild(o)
  }
  const cats = (info && Array.isArray(info.categories) ? info.categories : []).filter((c) => typeof c === 'string')
  add('', '未分类')
  if (info && info.aiClassify) add(AI_AUTO, 'AI 自动归类')
  for (const c of cats) add(c, c)
  const valid = (v) => typeof v === 'string' && (v === '' || v === AI_AUTO || cats.includes(v))
  const def = info && info.defaultCategory
  s.value = valid(remembered) ? remembered : valid(def) ? def : ''
  return s
}

// 保存表单卡片：标题 / 元信息 / 分类 / 按钮
function renderForm({ title, meta, note, info, remembered, onSaveClick }) {
  const card = el(`<div class="box">
      <div class="item-title"></div>
      ${meta ? '<div class="item-meta"></div>' : ''}
      ${note ? '<div class="box-text"></div>' : ''}
      <div class="field-label">保存到分类</div>
      <div class="row"></div>
      <button class="primary">保存到 PaperLens</button>
    </div>`)
  setText(card, '.item-title', title)
  if (meta) setText(card, '.item-meta', meta)
  if (note) setText(card, '.box-text', note)
  const select = categorySelect(info, remembered)
  card.querySelector('.row').replaceChildren(select)
  card.querySelector('.primary').addEventListener('click', () => onSaveClick(select.value))
  return card
}

function renderResult(r) {
  const ok = !!(r && r.ok)
  const dup = ok && r.status === 'duplicate'
  setStatus(dup ? '已在文库中' : ok ? '已保存' : '未能保存', ok ? 'on' : 'off')
  const head = dup ? '这篇已经在 PaperLens 文库里了：' : ok ? '已保存到 PaperLens：' : '未能保存：'
  $main.replaceChildren(setText(box(head, '', ok ? 'ok' : 'fail'), '.box-text', ok ? r.title : (r && r.message) || '未知原因'))
}

async function save(tab, item, category) {
  // 带着登录状态下载 PDF 需要这个站点的访问权限。权限申请必须在用户的点击动作里发起，
  // 所以放在一切界面切换之前；每个站点只问一次，之后浏览器记得住
  const origins = [...new Set((item.attachments || []).map((u) => {
    try {
      return /^https?:\/\//i.test(u) ? new URL(u).origin + '/*' : null
    } catch (e) {
      return null
    }
  }).filter(Boolean))]
  if (origins.length) {
    const has = await chrome.permissions.contains({ origins }).catch(() => false)
    if (!has) {
      const granted = await chrome.permissions.request({ origins }).catch(() => false)
      if (!granted) {
        return renderResult({ ok: false, message: '需要允许扩展访问这个站点，才能带着登录状态下载 PDF。可以在浏览器的扩展管理页里重新授权后重试。' })
      }
    }
  }
  setStatus('正在保存…')
  $main.replaceChildren(box('', '正在获取 PDF 并保存到 PaperLens…'))
  const r = await send('SAVE', { item, category })
  await chrome.storage.local.set({ category }).catch(() => {})
  renderResult(r)
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const pong = await send('PING')
  if (!pong || !pong.ok) return renderOffline()
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    setStatus('这页用不了', 'off')
    return $main.replaceChildren(box('', '请在论文页面（http / https 开头的网址）上使用。'))
  }
  const info = await send('INFO')
  const remembered = (await chrome.storage.local.get('category').catch(() => ({}))).category

  if (isPdfTab(tab.url)) {
    // 直接打开的 PDF：内置查看器上没法注入脚本，按标签页标题 + 当前地址交给应用
    const tabTitle = (tab.title || '').replace(/\s*\.pdf$/i, '').trim()
    const item = { title: looksLikeTitle(tabTitle) ? tabTitle : '', pageTitle: tabTitle, url: tab.url, attachments: [tab.url], creators: '', date: '', doi: '', venue: '' }
    setStatus('这是一份 PDF', 'on')
    $main.replaceChildren(
      renderForm({
        title: tabTitle || '未命名 PDF',
        note: '这份 PDF 将原样保存进文库' + (item.title ? '。' : '，标题按文件名识别。'),
        info,
        remembered,
        onSaveClick: (category) => void save(tab, item, category)
      })
    )
    return
  }

  const item = await extract(tab.id)
  if (!item || (!item.title && !(item.attachments || []).length)) {
    setStatus('没有识别到论文', 'off')
    return $main.replaceChildren(
      box(
        '',
        '这个页面上没有找到论文信息。请打开论文的详情页（如 IEEE Xplore 的 Document 页、arXiv 的摘要页）再试；也可以直接打开 PDF 文件后点扩展保存。'
      )
    )
  }
  const hasMeta = !!item.title
  setStatus(hasMeta ? '已识别本页论文' : '识别到 PDF 链接', hasMeta ? 'on' : '')
  const meta = [item.venue, item.creators, (item.date || '').slice(0, 10), item.doi ? 'DOI ' + item.doi : ''].filter(Boolean).join(' · ')
  $main.replaceChildren(
    renderForm({
      title: hasMeta ? item.title : item.pageTitle || '未命名 PDF',
      meta,
      note: hasMeta ? '' : '这个页面没有论文元数据，标题将按 PDF 文件名识别。',
      info,
      remembered,
      onSaveClick: (category) => void save(tab, item, category)
    })
  )
}

function renderOffline() {
  setStatus('未连接到 PaperLens', 'off')
  $main.replaceChildren(box('PaperLens 没有在运行', '请先打开 PaperLens 桌面应用，再点一次扩展图标。'))
}

main().catch((e) => {
  setStatus('出了点问题', 'off')
  $main.replaceChildren(box('', String((e && e.message) || e)))
})
