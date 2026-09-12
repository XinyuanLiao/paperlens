import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { Paper } from './types'

interface Props {
  paper: Paper
  page: number
  width: number
  onClose: () => void
}

function PageCanvas({ doc, num, scale }: { doc: any; num: number; scale: number }): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(num <= 2)
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null)

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
        const vp1 = pg.getViewport({ scale: 1 })
        if (!cancelled) setDim({ w: vp1.width, h: vp1.height })
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

// Chat 模式的引用面板：右侧连续滚动查看被引论文（不切换模式）
export default function RefViewer({ paper, page, width, onClose }: Props): JSX.Element {
  const [doc, setDoc] = useState<any>(null)
  const [err, setErr] = useState('')
  const [numPages, setNumPages] = useState(0)
  const [dims, setDims] = useState<Array<{ w: number; h: number }>>([])
  const [scale, setScale] = useState(1)
  const [cur, setCur] = useState(page)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setErr('')
    setCur(page)
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

  // 面板宽度变化 → 重新适配宽度
  const scrollRefCb = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (dims[0]) setScale(Math.max(0.5, Math.min(3, (el.clientWidth - 40) / dims[0].w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [dims])

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
            <div className="seg">
              <button onClick={() => setScale((s) => Math.max(0.5, s - 0.15))}>−</button>
              <button onClick={() => setScale(1)} title="适应宽度">
                {Math.round(scale * 100)}%
              </button>
              <button onClick={() => setScale((s) => Math.min(3, s + 0.15))}>+</button>
            </div>
          </div>
          <div className="ref-scroll" ref={scrollRefCb} onScroll={onScrollState}>
            {doc
              ? Array.from({ length: numPages }, (_, i) => (
                  <div key={i} data-refpage={i + 1} className="ref-page-slot">
                    <PageCanvas doc={doc} num={i + 1} scale={scale} />
                  </div>
                ))
              : !err && <div className="ref-loading">加载中…</div>}
          </div>
        </>
      )}
    </div>
  )
}
