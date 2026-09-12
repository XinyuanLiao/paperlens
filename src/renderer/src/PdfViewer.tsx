import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Tab } from './App'
import type { Highlight } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export interface ViewerHandle {
  scrollToPage: (n: number) => void
  highlightSelection: () => Promise<void>
  zoomBy: (delta: number) => void
  zoomReset: () => void
}

interface Props {
  tabs: Tab[]
  activeId: number | null
  onActivate: (id: number) => void
  onCloseTab: (id: number) => void
  pendingJump: { slug: string; page: number } | null
  onJumped: () => void
  onPageContext: (text: string) => void
  onSelect: (text: string, x: number, y: number) => void
  onDeleteHighlight: (id: number) => void
}

interface PageTextMap {
  [num: number]: string
}

const PdfViewer = forwardRef<ViewerHandle, Props>(function PdfViewer(
  { tabs, activeId, onActivate, onCloseTab, pendingJump, onJumped, onPageContext, onSelect, onDeleteHighlight },
  ref
): JSX.Element {
  const active = tabs.find((t) => t.paper.id === activeId) ?? null
  const [doc, setDoc] = useState<any>(null)
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

  // 滚动容器挂载后：容器尺寸变化 → 重新适配宽度并回到当前页
  const attachScrollEl = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    if (!el) return
    let t: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        if (baseVwRef.current > 0) {
          setBaseScale(Math.max(0.5, Math.min(2.2, (el.clientWidth - 56) / baseVwRef.current)))
          setZoom(1)
          setTimeout(() => {
            const target = pageRefs.current.get(curPageRef.current)
            const first = pageRefs.current.get(1)
            if (target && first) {
              const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
              el.scrollTo({ top, behavior: 'auto' })
            }
          }, 120)
        }
      }, 140)
    })
    ro.observe(el)
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => Math.max(0.4, Math.min(3, z - e.deltaY * 0.0018)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
  }, [])

  // Cmd/Ctrl + -/=/0 缩放
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
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
  }, [])

  useEffect(() => {
    setDoc(null)
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
            console.log('[hl] loaded', active.paper.id, hs.length)
            if (!cancelled) setHls(hs)
          })
          .catch((e) => console.error('[hl] load failed', e))
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
        const p1 = await d.getPage(1)
        const vw = p1.getViewport({ scale: 1 }).width
        baseVwRef.current = vw
        const w = scrollRef.current?.clientWidth ?? 800
        setBaseScale(Math.max(0.5, Math.min(2.2, (w - 56) / vw)))
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
  // （.shell/.workspace），把标题栏顶出窗口外
  const scrollToPage = useCallback((n: number) => {
    const sc = scrollRef.current
    const el = pageRefs.current.get(n)
    if (!sc || !el) return
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
    sc.scrollTo({ top, behavior: 'smooth' })
  }, [])

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
    console.log('[hl] saved', { id, pageNum, rects: rects.slice(0, 2) })
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

  useEffect(() => {
    if (doc && pendingJump && active && pendingJump.slug === active.paper.slug) {
      const t = setTimeout(() => {
        scrollToPage(pendingJump.page)
        onJumped()
      }, 350)
      return () => clearTimeout(t)
    }
  }, [doc, pendingJump, active, scrollToPage, onJumped])

  const onScroll = useCallback(() => {
    const sc = scrollRef.current
    if (!sc) return
    for (let n = 1; n <= numPages; n++) {
      const el = pageRefs.current.get(n)
      if (el && el.offsetTop + el.offsetHeight > sc.scrollTop + 80) {
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
  hls: Highlight[]
  onDeleteHl: (id: number) => void
  registerRef: (el: HTMLDivElement | null) => void
  onPageText: (n: number, text: string) => void
}

function PageView({ doc, num, scale, hls, onDeleteHl, registerRef, onPageText }: PageViewProps): JSX.Element {
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
    <div className="page-wrap" ref={(el) => { registerRef(el); (wrapRef as any).current = el }}>
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textRef} />
      {/* 高亮层置于文本层之上：点击高亮即删除 */}
      <div className="hl-layer" data-n={hls.length}>
        {console.log(`[hl] PageView ${num} renders ${hls.length} groups`)}
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
