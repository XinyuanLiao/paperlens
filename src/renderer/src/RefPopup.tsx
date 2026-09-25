import { useEffect, useRef, useState } from 'react'
import type { Paper, RefMeta } from './types'

// 参考文献弹窗：点击 PDF 里的引用标记/文献表条目后，展示该文献的元数据。
// 开放获取 → 一键下载并加入文库（走常规导入链）；非开源 → 跳发布页/谷歌学术自行下载。

interface Props {
  x: number
  y: number
  num: number
  raw: string
  papers: Paper[]
  category: string
  onOpenPaper: (slug: string) => void
  onClose: () => void
}

// 标题归一化：与本地库比对是否已在文库（纯字母数字比对，忽略标点/空格/大小写）
const normTitle = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')

const POP_W = 420

export default function RefPopup({ x, y, num, raw, papers, category, onOpenPaper, onClose }: Props): JSX.Element {
  const [meta, setMeta] = useState<RefMeta | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'fail'>('loading')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  useEffect(() => {
    setMeta(null)
    setErr('')
    setBusy(false)
    if (!raw) {
      setPhase('fail')
      return
    }
    setPhase('loading')
    let dead = false
    void window.api
      .lookupRef(raw)
      .then((m) => {
        if (dead) return
        if (m) {
          setMeta(m)
          setPhase('ready')
        } else setPhase('fail')
      })
      .catch(() => {
        if (!dead) setPhase('fail')
      })
    return () => {
      dead = true
    }
  }, [raw])

  // Esc / 点击弹窗外关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as Element).closest('.ref-pop')) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const inLib = meta ? papers.find((p) => normTitle(p.title) === normTitle(meta.title) && normTitle(meta.title).length > 8) : undefined
  const scholarQ = encodeURIComponent((meta?.title || raw).slice(0, 300))

  const doImport = async (): Promise<void> => {
    if (!meta?.pdfUrls.length || busy) return
    setErr('')
    setBusy(true)
    const r = await window.api
      .importRefPdf({
        urls: meta.pdfUrls,
        category,
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        venue: meta.venue
      })
      .catch((e): { ok: boolean; slug?: string; error?: string } => ({ ok: false, error: String(e) }))
    if (!alive.current) return
    if (r.ok && r.slug) {
      onOpenPaper(r.slug)
      onClose()
    } else {
      setBusy(false)
      setErr(r.error || '导入失败')
    }
  }

  const doCopy = (): void => {
    void navigator.clipboard
      .writeText(raw)
      .catch(() => {})
      .finally(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 900)
      })
  }

  // 点击点下方放不下就放上方；左右贴边内收
  const left = Math.min(Math.max(8, x + 10), window.innerWidth - POP_W - 8)
  const top = y + 18 + 280 > window.innerHeight ? Math.max(8, y - 298) : y + 18

  return (
    <div className="ref-pop" style={{ left, top, width: POP_W }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="ref-pop-head">
        <b>[{num}]</b>
        <span className="ref-pop-x" title="关闭" onClick={onClose}>
          ✕
        </span>
      </div>
      {phase === 'loading' && <div className="ref-pop-dim">正在查询该文献的信息…</div>}
      {phase === 'ready' && meta && (
        <>
          <div className="ref-pop-title">{meta.title}</div>
          {meta.authors && <div className="ref-pop-meta">{meta.authors}</div>}
          <div className="ref-pop-meta">
            {[meta.venue, meta.year, meta.citedBy != null ? `被引 ${meta.citedBy}` : ''].filter(Boolean).join(' · ') || ' '}
          </div>
          <div className="ref-pop-acts">
            {inLib ? (
              <button className="ref-pill pdf" onClick={() => (onOpenPaper(inLib.slug), onClose())}>
                已在文库 · 打开
              </button>
            ) : meta.pdfUrls.length > 0 ? (
              <button className="ref-pill pdf" disabled={busy} onClick={() => void doImport()}>
                {busy ? '下载中…' : '[PDF] 加入文库'}
              </button>
            ) : (
              <button className="ref-pill" onClick={() => window.api.openExternal(meta.landing || `https://scholar.google.com/scholar?q=${scholarQ}`)}>
                打开发布页自行下载
              </button>
            )}
            <button className="ref-pill" onClick={() => window.api.openExternal(`https://scholar.google.com/scholar?q=${scholarQ}`)}>
              Google 学术
            </button>
            <button className="ref-pill" onClick={doCopy}>
              {copied ? '已复制' : '复制条目'}
            </button>
          </div>
          {err && <div className="ref-pop-err">{err}</div>}
        </>
      )}
      {phase === 'fail' && (
        <>
          <div className="ref-pop-dim">未在学术库中识别到该文献，可跳转搜索或复制原文自行查询。</div>
          {raw && <div className="ref-pop-raw">{raw.slice(0, 260)}</div>}
          <div className="ref-pop-acts">
            <button className="ref-pill" onClick={() => window.api.openExternal(`https://scholar.google.com/scholar?q=${scholarQ}`)}>
              Google 学术搜索
            </button>
            {raw && (
              <button className="ref-pill" onClick={doCopy}>
                {copied ? '已复制' : '复制条目'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
