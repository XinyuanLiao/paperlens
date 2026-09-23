import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Tab } from './App'
import type { Highlight } from './types'
import { locateSnippet, locateByKeywords, flashHit } from './locate'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export interface ViewerHandle {
  scrollToPage: (n: number) => void
  highlightSelection: () => Promise<void>
  zoomBy: (delta: number) => void
  zoomReset: () => void
  removeHighlightLocal: (hid: number) => void
}

// ---------- 全文搜索 ----------
// 索引项：PDF 单位坐标（scale=1 viewport），匹配时按页面尺寸归一化
interface FindItem {
  str: string
  x: number
  y: number
  w: number
  h: number
  eol: boolean
}
interface NormRect {
  x: number
  y: number
  w: number
  h: number
}
interface FindHit {
  page: number
  rects: NormRect[]
}

// 单页匹配：把该页全部文本 run 拼成一条大字符串（y 跳变处插换行隔断跨栏/跨行误连），
// 命中区间再按 run 切回矩形（等宽近似：字符宽 = run 宽 / 字符数）
function findInPage(items: FindItem[], q: string, pageW: number, pageH: number): NormRect[] {
  if (!q || !items.length) return []
  const ql = q.toLowerCase()
  let text = ''
  const owner: number[] = [] // text[i] 属于哪个 item（-1 = 换行占位）
  const chAt: number[] = [] // text[i] 在其 item 内的字符偏移
  let prevY: number | null = null
  items.forEach((it, i) => {
    if (prevY !== null && Math.abs(it.y - prevY) > Math.max(it.h, 2) * 0.6) {
      text += '\n'
      owner.push(-1)
      chAt.push(0)
    }
    for (let c = 0; c < it.str.length; c++) {
      text += it.str[c]
      owner.push(i)
      chAt.push(c)
    }
    if (it.eol) {
      text += '\n'
      owner.push(-1)
      chAt.push(0)
    }
    prevY = it.y
  })
  const tl = text.toLowerCase()
  const out: NormRect[] = []
  let from = 0
  for (;;) {
    const at = tl.indexOf(ql, from)
    if (at < 0) break
    const end = at + ql.length
    let i = at
    while (i < end) {
      const seg = owner[i]
      if (seg < 0) {
        i++
        continue
      }
      let j = i
      while (j + 1 < end && owner[j + 1] === seg) j++
      const item = items[seg]
      const n = Math.max(1, item.str.length)
      const c0 = chAt[i]
      const c1 = chAt[j]
      out.push({
        x: (item.x + (item.w * c0) / n) / pageW,
        y: 1 - (item.y + item.h * 0.85) / pageH,
        w: (item.w * (c1 - c0 + 1)) / n / pageW,
        h: (item.h * 1.12) / pageH
      })
      i = j + 1
    }
    from = at + 1
  }
  return out
}

async function buildFindIndex(doc: any): Promise<Map<number, FindItem[]>> {
  const m = new Map<number, FindItem[]>()
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n)
    const tc = await pg.getTextContent()
    m.set(
      n,
      (tc.items as Array<{ str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }>)
        .filter((it) => typeof it.str === 'string' && it.transform)
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height, eol: !!it.hasEOL }))
    )
  }
  return m
}

interface Props {
  tabs: Tab[]
  activeId: number | null
  onActivate: (id: number) => void
  onCloseTab: (id: number) => void
  pendingJump: { slug: string; page: number; snippet?: string; probe?: string } | null
  onJumped: () => void
  onPageContext: (text: string) => void
  onSelect: (text: string, x: number, y: number) => void
  onDeleteHighlight: (id: number) => void
  // 面板常驻但 chat 模式下隐藏：隐藏时全局缩放快捷键不生效（让位给引用面板）
  visible: boolean
}

interface PageTextMap {
  [num: number]: string
}

const isMacKey = (): string => (/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl')

const PdfViewer = forwardRef<ViewerHandle, Props>(function PdfViewer(
  { tabs, activeId, onActivate, onCloseTab, pendingJump, onJumped, onPageContext, onSelect, onDeleteHighlight, visible },
  ref
): JSX.Element {
  const active = tabs.find((t) => t.paper.id === activeId) ?? null
  const [doc, setDoc] = useState<any>(null)
  const [pageDims, setPageDims] = useState<Array<{ w: number; h: number }>>([])
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  const textCache = useRef<PageTextMap>({})
  const baseVwRef = useRef(0)
  const curPageRef = useRef(1)
  const [hls, setHls] = useState<Highlight[]>([])
  const [zoom, setZoom] = useState(1)
  const [baseScale, setBaseScale] = useState(1)
  const [curPage, setCurPage] = useState(1)
  const [numPages, setNumPages] = useState(0)
  // 已打开文献的下拉选择（替代顶部标签条）：点开列表切换/关闭
  const [tabsOpen, setTabsOpen] = useState(false)
  useEffect(() => {
    if (!tabsOpen) return
    const h = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.tabselect')) setTabsOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [tabsOpen])

  // 全文搜索：索引惰性构建（首次打开搜索框时取全文），同 doc 复用
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [findHits, setFindHits] = useState<FindHit[]>([])
  const [findIdx, setFindIdx] = useState(0)
  const [findPhase, setFindPhase] = useState<'idle' | 'indexing' | 'ready'>('idle')
  const findIndexRef = useRef<Map<number, FindItem[]> | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const docRef = useRef<any>(null)
  useEffect(() => {
    docRef.current = doc
  }, [doc])

  // 挂载滚动容器：Ctrl+滚轮缩放；不再在 resize 时重缩放/回跳（保持阅读位置）
  const attachScrollEl = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => Math.max(0.4, Math.min(3, z - e.deltaY * 0.0018)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
  }, [])

  // 打开搜索框：立即聚焦输入；索引构建由下方 effect 兜底（doc 可能尚未就绪）
  const openFind = useCallback(() => {
    setFindOpen(true)
    setTimeout(() => findInputRef.current?.focus(), 30)
  }, [])

  // 搜索框开着但索引未建（首次打开 / 文档刚加载完）：后台逐页取全文建索引。
  // 只在 idle 态启动，失败停在 ready（无索引）不重试。
  // 不能用 cleanup cancelled：setFindPhase('indexing') 会触发本 effect 重跑，cleanup 把
  // 刚建好的索引丢掉（界面永远停在「建立索引…」）；过期索引用 docRef 比对丢弃
  useEffect(() => {
    if (!findOpen || !doc || findIndexRef.current || findPhase !== 'idle') return
    setFindPhase('indexing')
    void buildFindIndex(doc)
      .then((m) => {
        if (docRef.current !== doc) return // 已切文档：丢弃过期索引（新文档会重建）
        findIndexRef.current = m
        setFindPhase('ready')
      })
      .catch(() => {
        if (docRef.current === doc && !findIndexRef.current) setFindPhase('ready')
      })
  }, [findOpen, doc, findPhase])

  // Cmd/Ctrl + -/=/0 缩放、Ctrl/Cmd+F 搜索（仅阅读模式可见时生效；chat 模式下快捷键归引用面板）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!visible) return
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setZoom((z) => Math.min(3, z + 0.15))
      } else if (e.key === '-') {
        e.preventDefault()
        setZoom((z) => Math.max(0.4, z - 0.15))
      } else if (e.key === '0') {
        e.preventDefault()
        setZoom(1)
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openFind()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, openFind])

  // 关键词（防抖）→ 全部命中：逐页跑等宽匹配，按页序输出
  useEffect(() => {
    const q = findQ.trim()
    if (!findOpen || !q) {
      setFindHits([])
      setFindIdx(0)
      return
    }
    if (findPhase !== 'ready') return
    const t = setTimeout(() => {
      const idx = findIndexRef.current
      if (!idx) return
      const hits: FindHit[] = []
      for (let n = 1; n <= (pageDims.length || 0); n++) {
        const items = idx.get(n)
        const dim = pageDims[n - 1]
        if (!items || !dim) continue
        const rects = findInPage(items, q, dim.w, dim.h)
        if (rects.length) hits.push({ page: n, rects })
      }
      setFindHits(hits)
      setFindIdx(0)
    }, 220)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQ, findPhase, findOpen, doc, pageDims])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQ('')
    setFindHits([])
    setFindIdx(0)
  }, [])

  const gotoHit = useCallback(
    (dir: 1 | -1) => {
      if (!findHits.length) return
      setFindIdx((i) => (i + dir + findHits.length) % findHits.length)
    },
    [findHits]
  )

  // 跳到当前命中（与引用跳转同款定位：页内 y 焦点 + 页码同步）
  const scrollToHit = useCallback(
    (hit: FindHit) => {
      const sc = scrollRef.current
      const el = pageRefs.current.get(hit.page)
      if (!sc || !el) return
      const scTop = sc.getBoundingClientRect().top
      const elTop = el.getBoundingClientRect().top - scTop + sc.scrollTop
      const focus = elTop + hit.rects[0].y * el.offsetHeight - sc.clientHeight * 0.35
      sc.scrollTo({ top: Math.max(0, focus), behavior: 'auto' })
      setCurPage(hit.page)
      curPageRef.current = hit.page
      onPageContext(textCache.current[hit.page] ?? '')
    },
    [onPageContext]
  )

  const curHit = findHits.length ? findHits[Math.min(findIdx, findHits.length - 1)] : null
  useEffect(() => {
    if (curHit) scrollToHit(curHit)
    // 只在命中项/序号变化时跳转
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findIdx, findHits])

  // 按页分组的搜索高亮（当前命中单独一组渲染强调色）
  const findMap = useMemo(() => {
    const m = new Map<number, { rects: NormRect[]; cur: NormRect[] }>()
    if (!findOpen) return m
    for (const h of findHits) {
      const e = m.get(h.page) ?? { rects: [], cur: [] }
      e.rects.push(...h.rects)
      if (curHit === h) e.cur.push(...h.rects)
      m.set(h.page, e)
    }
    return m
  }, [findOpen, findHits, curHit])

  useEffect(() => {
    setDoc(null)
    setPageDims([])
    setNumPages(0)
    setError('')
    setHls([])
    textCache.current = {}
    // 换文档：搜索索引作废、结果清空（搜索框保持打开状态便于连续检索新文档）
    findIndexRef.current = null
    setFindPhase('idle')
    setFindHits([])
    setFindIdx(0)
    if (!active) return
    let cancelled = false
    void (async () => {
      try {
        const buf = await window.api.readPdf(active.paper.path)
        void window.api
          .listHighlights(active.paper.id)
          .then((hs) => {
            if (!cancelled) setHls(hs)
          })
          .catch(() => {})
        // 兼容 dev(http) 与打包(file://) 两种环境的静态资源基路径
        const assetBase = window.location.href.replace(/[^/]*$/, '')
        const d = await pdfjsLib.getDocument({
          data: new Uint8Array(buf),
          standardFontDataUrl: `${assetBase}standard_fonts/`,
          cMapUrl: `${assetBase}cmaps/`,
          cMapPacked: true
        }).promise
        if (cancelled) {
          void d.destroy()
          return
        }
        // 预取每页尺寸：未渲染页也能占出真实高度，页码跳转/滚动条才准确
        const metas: Array<{ w: number; h: number }> = []
        for (let n = 1; n <= d.numPages; n++) {
          const pg = await d.getPage(n)
          const vp = pg.getViewport({ scale: 1 })
          metas.push({ w: vp.width, h: vp.height })
        }
        if (cancelled) {
          void d.destroy()
          return
        }
        setPageDims(metas)
        baseVwRef.current = metas[0]?.w ?? 612
        const w = scrollRef.current?.clientWidth ?? 800
        setBaseScale(Math.max(0.5, Math.min(2.2, (w - 56) / baseVwRef.current)))
        setDoc(d)
        setNumPages(d.numPages)
        setCurPage(1)
        scrollRef.current?.scrollTo({ top: 0 })
        curPageRef.current = 1
      } catch (e) {
        setError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active?.paper.id])

  const scale = baseScale * zoom

  // 只滚动 .viewer-scroll 自身：scrollIntoView 会连带滚动 overflow:hidden 的祖先
  // （.shell/.workspace），把标题栏顶出窗口外。长距离跳页用瞬时滚动（平滑滚动
  // 在懒渲染内容变化时会被 Chromium 静默取消）
  const scrollToPage = useCallback(
    (n: number) => {
      const sc = scrollRef.current
      const el = pageRefs.current.get(n)
      if (!sc || !el) return
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
      const dist = Math.abs(top - sc.scrollTop)
      sc.scrollTo({ top, behavior: dist > sc.clientHeight * 2 ? 'auto' : 'smooth' })
      // 跳页立即同步页码指示（窗口被遮挡时 scroll 事件不会触发）
      setCurPage(n)
      curPageRef.current = n
      onPageContext(textCache.current[n] ?? '')
    },
    [onPageContext]
  )

  const goToPage = useCallback(
    (n: number) => {
      if (!numPages) return
      scrollToPage(Math.max(1, Math.min(numPages, n)))
    },
    [numPages, scrollToPage]
  )

  // 把当前选区保存为持久化高亮
  const highlightSelection = useCallback(async () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !active) return
    const range = sel.getRangeAt(0)
    let node: Node | null = range.startContainer
    let wrap: HTMLElement | null = null
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('page-wrap')) {
        wrap = node
        break
      }
      node = node.parentNode
    }
    if (!wrap) return
    let pageNum = 0
    for (const [n, el] of pageRefs.current.entries()) if (el === wrap) pageNum = n
    if (!pageNum) return
    const wrapRect = wrap.getBoundingClientRect()
    const rects = [...range.getClientRects()]
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({
        x: (r.left - wrapRect.left) / wrapRect.width,
        y: (r.top - wrapRect.top) / wrapRect.height,
        w: r.width / wrapRect.width,
        h: r.height / wrapRect.height
      }))
    if (rects.length === 0) return
    const text = sel.toString()
    const id = await window.api.addHighlight(active.paper.id, pageNum, rects, text)
    setHls((hs) => [...hs, { id, page: pageNum, rects, text }])
    sel.removeAllRanges()
  }, [active])

  useImperativeHandle(ref, () => ({
    scrollToPage,
    highlightSelection,
    zoomBy(delta: number) {
      setZoom((z) => Math.max(0.4, Math.min(3, z + delta)))
    },
    zoomReset() {
      setZoom(1)
    },
    removeHighlightLocal(hid: number) {
      setHls((hs) => hs.filter((h) => h.id !== hid))
    }
  }))

  // 引用跳转：snippet 精确定位到页内被引段落（多行高亮带渐隐）→ 无 snippet /
  // 未命中时用「问题 + 回答上下文」关键词定位（可能落到相邻页），否则停在该页顶部
  useEffect(() => {
    if (doc && pendingJump && active && pendingJump.slug === active.paper.slug) {
      let cancelled = false
      const t = setTimeout(() => {
        const pg = Math.max(1, Math.min(numPages || pendingJump.page, pendingJump.page))
        const sc = scrollRef.current
        if (!sc) return
        void (async () => {
          let hitPage = pg
          let el = pageRefs.current.get(hitPage)
          let hit = pendingJump.snippet ? await locateSnippet(doc, pg, pendingJump.snippet).catch(() => null) : null
          if (!hit && pendingJump.probe) {
            const kh = await locateByKeywords(doc, pg, pendingJump.probe).catch(() => null)
            if (kh) {
              hit = kh.hit
              hitPage = kh.page
              el = pageRefs.current.get(hitPage) ?? el
            }
          }
          if (cancelled) return
          if (!el) return
          const scTop = sc.getBoundingClientRect().top
          const elTop = el.getBoundingClientRect().top - scTop + sc.scrollTop
          const focus = hit ? elTop + hit.top * el.offsetHeight - sc.clientHeight * 0.3 : elTop
          sc.scrollTo({ top: Math.max(0, focus), behavior: 'auto' })
          setCurPage(hitPage)
          curPageRef.current = hitPage
          onPageContext(textCache.current[hitPage] ?? '')
          if (hit) flashHit(el, hit)
          onJumped()
        })()
      }, 350)
      return () => {
        cancelled = true
        clearTimeout(t)
      }
    }
  }, [doc, pendingJump, active, numPages, onPageContext, onJumped])

  const onScroll = useCallback(() => {
    const sc = scrollRef.current
    if (!sc) return
    // 用视口相对位置判定当前页（offsetTop 受 offsetParent 影响，不可靠）
    const scTop = sc.getBoundingClientRect().top
    for (let n = 1; n <= numPages; n++) {
      const el = pageRefs.current.get(n)
      if (el && el.getBoundingClientRect().bottom > scTop + 80) {
        setCurPage(n)
        curPageRef.current = n
        onPageContext(textCache.current[n] ?? '')
        return
      }
    }
  }, [numPages, onPageContext])

  const onMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      if (!sel || sel.isCollapsed || text.length < 2) return
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return
      // 浮条放选区上方（页顶放不下则放下方），x 用选区左缘——居中偏移会盖住下一行文字
      const barTop = rect.top > 54 ? rect.top - 42 : rect.bottom + 8
      onSelect(text, rect.left, barTop)
    },
    [onSelect]
  )

  if (!active) {
    return (
      <div className="pdf-pane">
        <div className="empty-viewer">
          <div className="big">📄</div>
          <div className="headline">从左侧选择一篇论文开始阅读</div>
          <div className="tip">
            选中文字即可 <span className="kbd">翻译</span> <span className="kbd">解释</span> <span className="kbd">追问</span>；右侧面板支持当前论文与全库 RAG 问答，回答自带页码引用。
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pdf-pane">
      <div className="viewer-toolbar">
        <div
          className="tabselect"
          onClick={() => setTabsOpen((o) => !o)}
          title={tabs.length > 1 ? `已打开 ${tabs.length} 篇，点击切换` : '当前文献'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
          </svg>
          <b>{active.paper.title}</b>
          {tabs.length > 1 && <span className="tabselect-n">{tabs.length}</span>}
          <svg className={`chev ${tabsOpen ? 'open' : ''}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
          {tabsOpen && (
            <div className="tabselect-menu">
              {tabs.map((t) => (
                <div
                  key={t.paper.id}
                  className={`tabselect-item ${t.paper.id === activeId ? 'on' : ''}`}
                  onClick={() => {
                    onActivate(t.paper.id)
                    setTabsOpen(false)
                  }}
                >
                  <span className="ts-title">{t.paper.title}</span>
                  <span
                    className="x"
                    title="关闭"
                    onClick={(e) => {
                      e.stopPropagation()
                      onCloseTab(t.paper.id)
                    }}
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <div className="seg" title="页面导航">
          <button onClick={() => goToPage(1)} disabled={curPage <= 1} title="首页">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" /></svg>
          </button>
          <button onClick={() => goToPage(curPage - 1)} disabled={curPage <= 1} title="上一页">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <span className="page-ind">
            {curPage} / {numPages || '…'}
          </span>
          <button onClick={() => goToPage(curPage + 1)} disabled={!numPages || curPage >= numPages} title="下一页">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
          </button>
          <button onClick={() => goToPage(numPages)} disabled={!numPages || curPage >= numPages} title="末页">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 7l5 5-5 5M6 7l5 5-5 5" /></svg>
          </button>
        </div>
        <div className="seg" title="缩放">
          <button onClick={() => setZoom((z) => Math.max(0.4, z - 0.15))}>−</button>
          <button onClick={() => setZoom(1)} title="适应宽度">{Math.round(scale * 100)}%</button>
          <button onClick={() => setZoom((z) => Math.min(3, z + 0.15))}>+</button>
        </div>
        <button
          className={`tool-btn ${findOpen ? 'on' : ''}`}
          title={`搜索（${isMacKey()}F）`}
          onClick={() => (findOpen ? closeFind() : openFind())}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </button>
      </div>
      {findOpen && (
        <div className="pdf-searchbar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.55 }}>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={findInputRef}
            className="pdf-search-input"
            placeholder="在本文档中搜索…"
            value={findQ}
            onChange={(e) => setFindQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                gotoHit(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
          />
          <span className="pdf-search-count">
            {findPhase === 'indexing'
              ? '建立索引…'
              : !findQ.trim()
                ? `${numPages || '…'} 页`
                : findHits.length
                  ? `${Math.min(findIdx + 1, findHits.length)} / ${findHits.length}`
                  : findPhase === 'ready'
                    ? '无匹配'
                    : ''}
          </span>
          <button className="tool-btn" title="上一个（Shift+Enter）" disabled={!findHits.length} onClick={() => gotoHit(-1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
          </button>
          <button className="tool-btn" title="下一个（Enter）" disabled={!findHits.length} onClick={() => gotoHit(1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <button className="tool-btn" title="关闭搜索（Esc）" onClick={closeFind}>✕</button>
        </div>
      )}
      <div className="viewer-scroll" ref={attachScrollEl} onMouseUp={onMouseUp} onScroll={onScroll}>
        {error && <div className="empty-viewer">PDF 打开失败：{error}</div>}
        {doc &&
          Array.from({ length: numPages }, (_, i) => (
            <PageView
              key={`${active.paper.id}-${i + 1}`}
              doc={doc}
              num={i + 1}
              scale={scale}
              dim={pageDims[i]}
              hls={hls.filter((h) => h.page === i + 1)}
              find={findMap.get(i + 1) ?? null}
              onDeleteHl={onDeleteHighlight}
              registerRef={(el) => {
                if (el) pageRefs.current.set(i + 1, el)
                else pageRefs.current.delete(i + 1)
              }}
              onPageText={(n, txt) => {
                textCache.current[n] = txt
                if (n === curPage) onPageContext(txt)
              }}
            />
          ))}
      </div>
    </div>
  )
})

interface PageViewProps {
  doc: any
  num: number
  scale: number
  dim?: { w: number; h: number }
  hls: Highlight[]
  find: { rects: NormRect[]; cur: NormRect[] } | null
  onDeleteHl: (id: number) => void
  registerRef: (el: HTMLDivElement | null) => void
  onPageText: (n: number, text: string) => void
}

function PageView({ doc, num, scale, dim, hls, find, onDeleteHl, registerRef, onPageText }: PageViewProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const taskRef = useRef<any>(null)
  const [visible, setVisible] = useState(num <= 2)
  const renderedFor = useRef(0)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && setVisible(true)),
      { root: el.closest('.viewer-scroll'), rootMargin: '600px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !doc || renderedFor.current === scale) return
    let cancelled = false
    const prevTask = taskRef.current
    if (prevTask) {
      try { prevTask.cancel() } catch { /* already done */ }
    }
    void (async () => {
      try {
      const page = await doc.getPage(num)
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current!
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const renderTask = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      } as any)
      taskRef.current = renderTask
      await renderTask.promise
      if (cancelled) return
      // 文本层（划词的关键）：includeMarkedContent 与官方 viewer 一致，
      // 保留标记结构后选择边界更贴近可视文字，减少选到相邻区域
      const container = textRef.current!
      container.innerHTML = ''
      container.style.setProperty('--scale-factor', String(viewport.scale))
      const tl = new (pdfjsLib as any).TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container,
        viewport
      })
      await tl.render()
      // 选择体验三处修正：
      // ① 移除 endOfContent（pdf.js 的「点空白全选」辅助层）——轻微向下过划就会
      //    扩展成整页选中，我们不需要该特性；
      // ② 剔除页边行号：两栏正文外侧极左/极右的短纯数字（1-4 位）；
      // ③ 剔除页边的纯空白 run：透明但占位，拖选扫过会出现「莫名的选中高亮」
      // （全文搜索/引用定位走 getTextContent，不受 DOM 清理影响）
      try {
        container.querySelector('.endOfContent')?.remove()
        const cw = container.clientWidth || 1
        for (const el of [...container.querySelectorAll('span')] as HTMLElement[]) {
          if (el.classList.contains('markedContent')) continue
          const txt = (el.textContent ?? '').trim()
          const isMarginJunk = txt === '' || /^\d{1,4}$/.test(txt)
          if (!isMarginJunk) continue
          const leftPct = parseFloat(el.style.left)
          const ratio = (!isNaN(leftPct) && el.style.left.includes('%') ? leftPct / 100 : el.offsetLeft / cw)
          if (ratio < 0.03 || ratio > 0.965) el.remove()
        }
      } catch {
        /* 文本层清理失败不影响阅读 */
      }
      if (cancelled) return
      const tc = await page.getTextContent()
      const txt = (tc.items as Array<{ str: string; hasEOL?: boolean }>)
        .map((it) => it.str + (it.hasEOL ? '\n' : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
      renderedFor.current = scale
      onPageText(num, txt)
      } catch (e) {
        if (!String(e).toLowerCase().includes('cancel')) {
          console.error(`[page ${num}] render failed:`, e)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [visible, doc, scale, num])

  // 卸载时取消进行中的渲染任务
  useEffect(() => {
    return () => {
      try { taskRef.current?.cancel() } catch { /* noop */ }
    }
  }, [])

  return (
    <div
      className="page-wrap"
      ref={(el) => { registerRef(el); (wrapRef as any).current = el }}
      style={dim ? { width: Math.floor(dim.w * scale), height: Math.floor(dim.h * scale) } : undefined}
    >
      <canvas ref={canvasRef} style={dim ? { width: Math.floor(dim.w * scale), height: Math.floor(dim.h * scale) } : undefined} />
      <div className="textLayer" ref={textRef} />
      {/* 高亮层置于文本层之上：点击高亮即删除 */}
      <div className="hl-layer" data-n={hls.length}>
        {hls.map((h) => (
          <div
            key={h.id}
            className="hl-group"
            title={`${h.text.slice(0, 80)}\n（点击删除高亮）`}
            onClick={(e) => {
              e.stopPropagation()
              onDeleteHl(h.id)
            }}
          >
            {h.rects.map((r, i) => (
              <div
                key={i}
                className="hl"
                style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
              />
            ))}
          </div>
        ))}
      </div>
      {/* 全文搜索高亮层：全部命中淡黄，当前命中强调 */}
      {find && (
        <div className="find-layer">
          {find.rects.map((r, i) => (
            <div key={`a${i}`} className="find-hl" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />
          ))}
          {find.cur.map((r, i) => (
            <div key={`c${i}`} className="find-hl cur" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />
          ))}
        </div>
      )}
    </div>
  )
}

export default PdfViewer
