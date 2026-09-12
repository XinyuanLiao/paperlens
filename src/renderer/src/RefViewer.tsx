import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { Paper } from './types'

interface Props {
  paper: Paper
  page: number
  onClose: () => void
}

// Chat 模式的引用面板：右侧滑出，直接展示被引论文的对应页（不切换模式）
export default function RefViewer({ paper, page, onClose }: Props): JSX.Element {
  const [doc, setDoc] = useState<any>(null)
  const [err, setErr] = useState('')
  const [cur, setCur] = useState(page)
  const [numPages, setNumPages] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1.3)

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setErr('')
    setCur(Math.max(1, page))
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
        setNumPages(d.numPages)
        setDoc(d)
      } catch (e) {
        setErr(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [paper.id])

  useEffect(() => {
    if (!doc) return
    let cancelled = false
    let task: any = null
    void (async () => {
      try {
        const pg = await doc.getPage(Math.max(1, Math.min(numPages, cur)))
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
        scrollRef.current?.scrollTo({ top: 0 })
      } catch (e) {
        if (!String(e).toLowerCase().includes('cancel')) console.error('[ref] render:', e)
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
  }, [doc, cur, scale])

  return (
    <div className="ref-viewer">
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
            <button onClick={() => setCur((n) => Math.max(1, n - 1))} disabled={cur <= 1} title="上一页">
              ‹
            </button>
            <span className="page-ind">
              p.{cur} / {numPages || '…'}
            </span>
            <button onClick={() => setCur((n) => Math.min(numPages, n + 1))} disabled={!numPages || cur >= numPages} title="下一页">
              ›
            </button>
            <span style={{ flex: 1 }} />
            <div className="seg">
              <button onClick={() => setScale((s) => Math.max(0.6, s - 0.15))}>−</button>
              <button onClick={() => setScale(1.3)}>{Math.round(scale * 100)}%</button>
              <button onClick={() => setScale((s) => Math.min(3, s + 0.15))}>+</button>
            </div>
          </div>
          <div className="ref-scroll" ref={scrollRef}>
            <div className="page-wrap" style={{ width: '100%' }}>
              <canvas ref={canvasRef} style={{ width: '100%' }} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
