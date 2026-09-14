import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { Paper } from './types'
import { locateSnippet, locateByKeywords, flashHit } from './locate'

interface Props {
  paper: Paper
  page: number
  snippet?: string
  // 整篇问答等无 snippet 场景：用「问题 + 回答上下文」做关键词定位
  probe?: string
  width: number
  onClose: () => void
}

function PageCanvas({ doc, num, scale, dim }: { doc: any; num: number; scale: number; dim?: { w: number; h: number } }): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(num <= 2)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && setVisible(true)),
      { root: el.closest('.ref-scroll'), rootMargin: '600px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !doc) return
    let cancelled = false
    let task: any = null
    void (async () => {
      try {
        const pg = await doc.getPage(num)
        if (cancelled) return
        const viewport = pg.getViewport({ scale })
        const canvas = canvasRef.current!
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        task = pg.render({ canvas, canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined } as any)
        await task.promise
      } catch (e) {
        if (!String(e).toLowerCase().includes('cancel')) console.error(`[ref p${num}]`, e)
      }
    })()
    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        /* noop */
      }
    }
  }, [visible, doc, num, scale])

  // 尺寸由父组件（预取的 dims）提供：所有页一开始就占出真实高度，跳页滚动才准确
  return (
    <div
      className="page-wrap"
      ref={wrapRef}
      style={dim ? { width: Math.floor(dim.w * scale), height: Math.floor(dim.h * scale) } : { width: '100%', height: 600 }}
    >
      <canvas ref={canvasRef} style={dim ? { width: Math.floor(dim.w * scale), height: Math.floor(dim.h * scale) } : { width: '100%' }} />
    </div>
  )
}

// Chat 模式的引用面板：右侧连续滚动查看被引论文（不切换模式）。
// 打开即定位到被引页：snippet 精确定位 → 关键词定位；放大后可左右滚动（CSS 用
// max-content + auto 边距，flex 居中溢出时左半页不可达）；Ctrl/⌘+滚轮（触控板
// pinch 同信号）与 +/-/0 快捷键缩放，以视口中心为锚点保持阅读位置
export default function RefViewer({ paper, page, snippet, probe, width, onClose }: Props): JSX.Element {
  const [doc, setDoc] = useState<any>(null)
  const [err, setErr] = useState('')
  const [numPages, setNumPages] = useState(0)
  const [dims, setDims] = useState<Array<{ w: number; h: number }>>([])
  const [scale, setScale] = useState(1)
  const [cur, setCur] = useState(page)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const fitScaleRef = useRef(1)
  // 手动缩放后面板宽度变化不再自动重适配（避免覆盖用户的缩放）；换文档/点适应宽度时复位
  const manualZoom = useRef(false)
  const zoomAnchor = useRef<{ rx: number; ry: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setErr('')
    setCur(page)
    manualZoom.current = false
    void (async () => {
      try {
        const buf = await window.api.readPdf(paper.path)
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
        setNumPages(d.numPages)
        setDims(metas)
        setDoc(d)
      } catch (e) {
        setErr(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [paper.id])

  // 面板宽度变化 → 未手动缩放时重新适配宽度（按被引页尺寸）
  const refScrollCb = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !dims[0]) return
    const fit = (): void => {
      if (manualZoom.current) return
      const d = dims[Math.min(Math.max(page, 1), dims.length) - 1] ?? dims[0]
      const s = Math.max(0.5, Math.min(3, (el.clientWidth - 40) / d.w))
      fitScaleRef.current = s
      setScale(s)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dims, width, page])

  // 缩放锚定：记录视口中心在内容里的比例，缩放后回到同一处
  const captureAnchor = useCallback((): void => {
    const sc = scrollRef.current
    if (!sc) return
    zoomAnchor.current = {
      rx: sc.scrollWidth > 0 ? (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth : 0.5,
      ry: sc.scrollHeight > 0 ? (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight : 0.5
    }
  }, [])
  useEffect(() => {
    const a = zoomAnchor.current
    const sc = scrollRef.current
    if (!a || !sc) return
    sc.scrollLeft = Math.max(0, a.rx * sc.scrollWidth - sc.clientWidth / 2)
    sc.scrollTop = Math.max(0, a.ry * sc.scrollHeight - sc.clientHeight / 2)
    zoomAnchor.current = null
  }, [scale])

  // 触控板 pinch / Ctrl+滚轮缩放（passive:false 才能拦下浏览器整页缩放）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      captureAnchor()
      manualZoom.current = true
      setScale((s) => Math.max(0.4, Math.min(3.5, s - e.deltaY * 0.0022)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [captureAnchor])

  // Cmd/Ctrl + -/=/0 缩放（阅读态的 PdfViewer 快捷键按可见性门控，互不冲突）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        captureAnchor()
        manualZoom.current = true
        setScale((s) => Math.min(3.5, s + 0.15))
      } else if (e.key === '-') {
        e.preventDefault()
        captureAnchor()
        manualZoom.current = true
        setScale((s) => Math.max(0.4, s - 0.15))
      } else if (e.key === '0') {
        e.preventDefault()
        manualZoom.current = false
        setScale(fitScaleRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [captureAnchor])

  // 文档就绪后跳到被引页：snippet 精确定位 → 关键词定位（可能落到相邻页），否则页顶
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    void (async () => {
      let hitPage = page
      let hit = snippet ? await locateSnippet(doc, page, snippet).catch(() => null) : null
      if (!hit && probe) {
        const kh = await locateByKeywords(doc, page, probe).catch(() => null)
        if (kh) {
          hit = kh.hit
          hitPage = kh.page
        }
      }
      if (cancelled) return
      const sc = scrollRef.current
      const slot = sc?.querySelector<HTMLElement>(`[data-refpage="${hitPage}"]`)
      if (!sc || !slot) return
      const scTop = sc.getBoundingClientRect().top
      const slotTop = slot.getBoundingClientRect().top - scTop + sc.scrollTop
      const focus = hit ? slotTop + hit.top * slot.offsetHeight - sc.clientHeight * 0.3 : slotTop - 8
      sc.scrollTo({ top: Math.max(0, focus), behavior: 'auto' })
      setCur(hitPage)
      if (hit) {
        const wrap = slot.querySelector<HTMLElement>('.page-wrap')
        if (wrap) flashHit(wrap, hit)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc, page, snippet, probe])

  const onScrollState = useCallback(() => {
    const sc = scrollRef.current
    if (!sc || !numPages) return
    const scTop = sc.getBoundingClientRect().top
    for (let n = 1; n <= numPages; n++) {
      const el = sc.querySelector(`[data-refpage="${n}"]`)
      if (el && el.getBoundingClientRect().bottom > scTop + 60) {
        setCur(n)
        return
      }
    }
  }, [numPages])

  const zoomBtn = (delta: number): void => {
    captureAnchor()
    manualZoom.current = true
    setScale((s) => Math.max(0.4, Math.min(3.5, s + delta)))
  }
  const fitBtn = (): void => {
    manualZoom.current = false
    const sc = scrollRef.current
    const d = dims[Math.min(Math.max(page, 1), dims.length) - 1] ?? dims[0]
    if (sc && d) {
      fitScaleRef.current = Math.max(0.5, Math.min(3, (sc.clientWidth - 40) / d.w))
    }
    setScale(fitScaleRef.current)
  }

  return (
    <div className="ref-viewer" style={{ width }}>
      <div className="ref-head">
        <span className="ref-tag">引用</span>
        <span className="ellipsis ref-title" title={paper.title}>
          {paper.title}
        </span>
        <button className="icon-btn" title="关闭引用面板" onClick={onClose}>
          ✕
        </button>
      </div>
      {err ? (
        <div className="ref-err">{err}</div>
      ) : (
        <>
          <div className="ref-toolbar">
            <span className="page-ind">
              p.{cur} / {numPages || '…'}
            </span>
            <span style={{ flex: 1 }} />
            <div className="seg" title="缩放（Ctrl/⌘+滚轮 / 触控板捏合 / Ctrl/⌘ ±0）">
              <button onClick={() => zoomBtn(-0.15)}>−</button>
              <button onClick={fitBtn} title="适应宽度">
                {Math.round(scale * 100)}%
              </button>
              <button onClick={() => zoomBtn(0.15)}>+</button>
            </div>
          </div>
          <div className="ref-scroll" ref={refScrollCb} onScroll={onScrollState}>
            {doc
              ? Array.from({ length: numPages }, (_, i) => (
                  <div key={i} data-refpage={i + 1} className="ref-page-slot">
                    <PageCanvas doc={doc} num={i + 1} scale={scale} dim={dims[i]} />
                  </div>
                ))
              : !err && <div className="ref-loading">加载中…</div>}
          </div>
        </>
      )}
    </div>
  )
}
