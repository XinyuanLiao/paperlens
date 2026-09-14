import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
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

  // Cmd/Ctrl + -/=/0 缩放（仅阅读模式可见时生效；chat 模式下同一组快捷键归引用面板）
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])

  useEffect(() => {
    setDoc(null)
    setPageDims([])
    setNumPages(0)
    setError('')
    setHls([])
    textCache.current = {}
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
      if (!sel || text.length < 2) return
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return
      onSelect(text, rect.left + rect.width / 2 - 90, rect.bottom + 6)
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
      <div className="tabbar">
        {tabs.map((t) => (
          <div
            key={t.paper.id}
            className={`tab ${t.paper.id === activeId ? 'active' : ''}`}
            onClick={() => onActivate(t.paper.id)}
            title={t.paper.title}
          >
            <span className="tab-title">{t.paper.title}</span>
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
      <div className="viewer-toolbar">
        <span className="slug" title={active.paper.title}>
          <b>{active.paper.title}</b>
        </span>
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
      </div>
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
  onDeleteHl: (id: number) => void
  registerRef: (el: HTMLDivElement | null) => void
  onPageText: (n: number, text: string) => void
}

function PageView({ doc, num, scale, dim, hls, onDeleteHl, registerRef, onPageText }: PageViewProps): JSX.Element {
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
      // 文本层（划词的关键）
      const container = textRef.current!
      container.innerHTML = ''
      container.style.setProperty('--scale-factor', String(viewport.scale))
      const tl = new (pdfjsLib as any).TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: false, disableNormalization: true }),
        container,
        viewport
      })
      await tl.render()
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
    </div>
  )
}

export default PdfViewer
