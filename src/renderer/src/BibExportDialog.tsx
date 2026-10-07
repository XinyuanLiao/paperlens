import { useEffect, useState } from 'react'
import type { BibExportEntry, BibExportResult } from './types'

interface Props {
  onClose: () => void
}

// 警告 code → 中文说明（tooltip 与列表尾注用）
const WARN_TEXT: Record<string, string> = {
  unverified: '未能联网核对，字段按库内信息拼装，请人工确认',
  'no-venue': '缺期刊/会议信息（条目为 @misc）',
  'no-year': '缺年份',
  'no-authors': '缺作者'
}

const SOURCE_LABEL: Record<BibExportEntry['source'], string> = {
  official: '官方核对',
  web: '联网核对',
  local: '本地拼装'
}

// BibTeX 导出确认弹窗：打开即启动联网核对（进度），完成后列出全部条目——
// 逐条可勾选/展开预览，警告条目醒目标注，确认后才写盘。核对中关闭 = 取消主进程循环。
export default function BibExportDialog({ onClose }: Props): JSX.Element {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<BibExportResult | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  useEffect(() => {
    void window.api.bibExportRun()
    const offP = window.api.onBibProgress((p) => {
      if (p.phase === 'run') setProgress({ done: p.done, total: p.total })
    })
    const offR = window.api.onBibResult((r) => {
      setResult(r)
      setChecked(new Set(r.entries.map((e) => e.slug)))
      setProgress(null)
    })
    return () => {
      offP()
      offR()
    }
  }, [])

  const close = (): void => {
    // 核对还在跑就关窗 = 取消本轮（已出结果则直接关）
    if (!result) void window.api.bibExportCancel()
    onClose()
  }

  const rerun = (): void => {
    setResult(null)
    setSavedPath(null)
    setProgress({ done: 0, total: 0 })
    void window.api.bibExportRun(true)
  }

  const toggle = (slug: string): void => {
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(slug)) n.delete(slug)
      else n.add(slug)
      return n
    })
  }

  const allChecked = result != null && checked.size === result.entries.length
  const toggleAll = (): void => {
    if (!result) return
    setChecked(allChecked ? new Set() : new Set(result.entries.map((e) => e.slug)))
  }

  const doExport = async (): Promise<void> => {
    if (!result || checked.size === 0 || saving) return
    setSaving(true)
    try {
      const r = await window.api.bibExportSave([...checked])
      if (r.ok) setSavedPath(r.path ?? '')
      else if (!r.canceled && r.error) alert(`导出失败：${r.error}`)
    } finally {
      setSaving(false)
    }
  }

  const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0

  return (
    <div className="modal-mask" onMouseDown={close}>
      <div className="modal bib-modal" style={{ width: 640 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>导出 BibTeX</h2>
          <button className="modal-x" title={result ? '关闭' : '取消核对并关闭'} onClick={close}>
            ✕
          </button>
        </div>

        <div className="bib-body">
          {!result && (
            <div className="bib-checking">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="bib-checking-label">
                {progress
                  ? `正在联网核对 ${progress.done}/${progress.total} —— 优先取 DOI 官方条目，未命中降级为本地拼装并标注`
                  : '正在准备核对…'}
              </div>
              {progress && progress.total > 8 && (
                <div className="bib-checking-sub">条目较多时约需 {Math.ceil((progress.total * 1.4) / 60)} 分钟（学术接口限速），可关闭窗口稍后再来</div>
              )}
            </div>
          )}

          {result && (
            <>
              <div className="bib-summary">
                共 {result.entries.length} 条 ·{' '}
                <span className="bib-src official">官方核对 {result.official}</span> ·{' '}
                <span className="bib-src web">联网核对 {result.web}</span> ·{' '}
                <span className={`bib-src local${result.local ? ' warn' : ''}`}>本地拼装 {result.local}</span>
                {result.local > 0 && <span className="bib-summary-note">（本地条目未经联网核实，建议展开确认）</span>}
              </div>
              <div className="bib-list-head">
                <label className="bib-checkall">
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} /> 全选
                </label>
                <span className="hint">勾选要导出的条目 · 点条目展开 BibTeX 预览</span>
              </div>
              <div className="bib-rows">
                {result.entries.map((e) => (
                  <div key={e.slug} className={`bib-row-wrap ${e.source}`}>
                    <div className="bib-row" onClick={() => setExpanded(expanded === e.slug ? null : e.slug)}>
                      <input
                        type="checkbox"
                        checked={checked.has(e.slug)}
                        onClick={(ev) => ev.stopPropagation()}
                        onChange={() => toggle(e.slug)}
                      />
                      <span className="bib-row-title ellipsis" title={e.title}>
                        {e.title}
                      </span>
                      <code className="bib-key">{e.key}</code>
                      <span className={`bib-src-badge ${e.source}`}>{SOURCE_LABEL[e.source]}</span>
                      {e.warnings.length > 0 && (
                        <span className="bib-warn" title={e.warnings.map((w) => WARN_TEXT[w] ?? w).join('；')}>
                          ⚠
                        </span>
                      )}
                    </div>
                    {expanded === e.slug && <pre className="bib-pre">{e.bibtex}</pre>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-actions">
          {savedPath ? (
            <>
              <span className="hint" style={{ flex: 1 }} title={savedPath}>
                已导出 {result?.entries.filter((e) => checked.has(e.slug)).length ?? 0} 条到 {savedPath}
              </span>
              <button className="btn" onClick={onClose}>
                完成
              </button>
            </>
          ) : result ? (
            <>
              <span className="hint" style={{ flex: 1 }}>
                已选 {checked.size}/{result.entries.length} 条
              </span>
              <button className="btn ghost" onClick={rerun}>
                重新联网核对
              </button>
              <button className="btn" disabled={checked.size === 0 || saving} onClick={() => void doExport()}>
                {saving ? '导出中…' : `导出 ${checked.size} 条`}
              </button>
            </>
          ) : (
            <>
              <span className="hint" style={{ flex: 1 }}>
                核对结果缓存 7 天，重复导出即时完成。
              </span>
              <button className="btn ghost" onClick={close}>
                取消核对
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
