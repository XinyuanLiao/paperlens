import { useEffect, useRef, useState } from 'react'
import type { ImportOutcome } from './types'

interface QueueItem {
  path: string
  name: string
  status: 'pending' | 'working' | 'done' | 'failed'
  category?: string
  classified?: boolean
  error?: string
}

interface Props {
  initialFiles: string[]
  hasApiKey: boolean
  onBusyChange: (busy: boolean) => void
  onClose: () => void
  onFinished: (outcomes: ImportOutcome[]) => void
}

// 导入弹窗：拖入 / 选文件 / 选文件夹 → 逐篇进度 + AI 归类结果 + 汇总提示
export default function ImportDialog({ initialFiles, hasApiKey, onBusyChange, onClose, onFinished }: Props): JSX.Element {
  const [items, setItems] = useState<QueueItem[]>(() =>
    initialFiles.filter((p) => p.toLowerCase().endsWith('.pdf')).map((p) => ({ path: p, name: p.replace(/.*[\\/]/, ''), status: 'pending' }))
  )
  const [folders, setFolders] = useState<string[]>(() => initialFiles.filter((p) => !p.toLowerCase().endsWith('.pdf')))
  const [phase, setPhase] = useState<'idle' | 'importing' | 'done'>('idle')
  const [dragOver, setDragOver] = useState(false)
  const started = useRef(false)

  const addPaths = (paths: string[]): void => {
    if (phase !== 'idle') return
    const pdfs = paths.filter((p) => p.toLowerCase().endsWith('.pdf'))
    const dirs = paths.filter((p) => !p.toLowerCase().endsWith('.pdf'))
    setItems((its) => {
      const seen = new Set(its.map((i) => i.path.toLowerCase()))
      const add = pdfs
        .filter((p) => p && !seen.has(p.toLowerCase()))
        .map((p) => ({ path: p, name: p.replace(/.*[\\/]/, ''), status: 'pending' as const }))
      return [...its, ...add]
    })
    if (dirs.length) setFolders((fs) => [...fs, ...dirs.filter((d) => !fs.includes(d))])
  }

  const pickFiles = async (): Promise<void> => {
    const paths = await window.api.pickImport()
    addPaths(paths)
  }
  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickImportFolder()
    if (dir) addPaths([dir])
  }

  // 逐篇结果事件：按文件名匹配队列；匹配不到（文件夹展开出的文件）就追加一行
  useEffect(
    () =>
      window.api.onImportFile((o) => {
        setItems((its) => {
          const idx = its.findIndex((i) => i.name === o.file && (i.status === 'pending' || i.status === 'working'))
          const row: QueueItem = o.ok
            ? { path: '', name: o.file, status: 'done', category: o.category, classified: o.classified }
            : { path: '', name: o.file, status: 'failed', error: o.error }
          if (idx < 0) return [...its, row]
          const next = [...its]
          next[idx] = { ...next[idx], ...row, path: next[idx].path }
          return next
        })
      }),
    []
  )
  // 当前处理到哪一篇（导入中高亮行）
  useEffect(
    () =>
      window.api.onImportProgress((p) => {
        if (!p.current) return
        setItems((its) => {
          const idx = its.findIndex((i) => i.name === p.current && i.status === 'pending')
          if (idx < 0) return its
          const next = [...its]
          next[idx] = { ...next[idx], status: 'working' }
          return next
        })
      }),
    []
  )

  const start = (): void => {
    if (phase !== 'idle' || (items.length === 0 && folders.length === 0) || started.current) return
    started.current = true
    setPhase('importing')
    onBusyChange(true)
    void window.api
      .importPapers([...items.map((i) => i.path), ...folders])
      .then((r) => {
        setPhase('done')
        onFinished(r.outcomes)
      })
      .catch(() => {
        setPhase('done')
        onFinished([]) // 失败也要走收尾：刷新列表 + 解除导入忙状态
      })
      .finally(() => onBusyChange(false))
  }

  // 拖入文件直接开弹窗时自动开始
  useEffect(() => {
    if (initialFiles.length > 0) start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doneCount = items.filter((i) => i.status === 'done' || i.status === 'failed').length
  const okCount = items.filter((i) => i.status === 'done').length
  const catSummary = (() => {
    const m = new Map<string, number>()
    for (const i of items) if (i.status === 'done' && i.category) m.set(i.category, (m.get(i.category) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ×${n}`)
  })()

  return (
    <div className="modal-mask" onMouseDown={phase === 'importing' ? undefined : onClose}>
      <div className="modal modal-pad import-modal" style={{ width: 520 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>导入 PDF 文献</h2>
          <button className="modal-x" title={phase === 'importing' ? '导入中，可最小化窗口等待' : '关闭'} onClick={onClose}>
            ✕
          </button>
        </div>

        {phase === 'idle' && (
          <div
            className={`import-drop ${dragOver ? 'on' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(false)
              const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean)
              addPaths(paths)
            }}
          >
            <div className="import-drop-icon">📄</div>
            <div className="import-drop-tip">把 PDF 拖到这里</div>
            <div className="import-drop-sub">或</div>
            <div className="import-drop-actions">
              <button className="btn ghost" onClick={() => void pickFiles()}>
                选择文件
              </button>
              <button className="btn ghost" onClick={() => void pickFolder()}>
                选择文件夹（导入其中全部 PDF）
              </button>
            </div>
            {!hasApiKey && <div className="import-warn">未配置 API Key：导入后不做 AI 归类，统一放入 inbox 分类。</div>}
          </div>
        )}

        {items.length > 0 && (
          <>
            <div className="import-queue">
              {folders.length > 0 && (
                <div className="import-row folder">
                  <span className="import-row-name ellipsis" title={folders.join('\n')}>
                    📁 {folders.length} 个文件夹（导入时展开全部 PDF）
                  </span>
                </div>
              )}
              {items.map((it, i) => (
                <div key={`${it.path}-${i}`} className={`import-row ${it.status}`}>
                  <span className="import-row-name ellipsis" title={it.path}>
                    {it.name}
                  </span>
                  {it.status === 'pending' && phase === 'idle' && (
                    <button className="import-row-x" title="移出队列" onClick={() => setItems((its) => its.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                  {it.status === 'pending' && phase !== 'idle' && <span className="import-st pending">排队</span>}
                  {it.status === 'working' && <span className="import-st working">AI 归类中…</span>}
                  {it.status === 'done' && (
                    <span className="import-st done" title={it.classified ? 'AI 自动归类' : '未调用 AI'}>
                      ✓ {it.category || 'inbox'}
                    </span>
                  )}
                  {it.status === 'failed' && (
                    <span className="import-st failed" title={it.error}>
                      失败
                    </span>
                  )}
                </div>
              ))}
            </div>
            {(phase === 'importing' || phase === 'done') && (
              <div className="import-progress">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${items.length ? (doneCount / items.length) * 100 : 0}%` }} />
                </div>
                <div className="import-progress-label">
                  {phase === 'importing' ? `导入中 ${doneCount}/${items.length} · AI 归类并入库` : `完成：成功 ${okCount} · 失败 ${items.length - okCount}`}
                </div>
              </div>
            )}
            {phase === 'done' && catSummary.length > 0 && <div className="import-cats">归类：{catSummary.join('、')}</div>}
          </>
        )}

        <div className="modal-actions">
          {phase === 'idle' ? (
            <>
              <span className="hint" style={{ flex: 1 }}>
                导入后自动做 AI 归类并建索引，随后在阅读区打开。
              </span>
              <button className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button className="btn" disabled={items.length === 0 && folders.length === 0} onClick={start}>
                导入 {items.length + folders.length > 0 ? `${items.length + folders.length} 项` : ''}
              </button>
            </>
          ) : phase === 'importing' ? (
            <>
              <span className="hint" style={{ flex: 1 }}>
                正在逐篇入库，可关闭此窗继续后台导入。
              </span>
              <button className="btn ghost" onClick={onClose}>
                后台运行
              </button>
            </>
          ) : (
            <>
              <span className="hint" style={{ flex: 1 }}>
                {okCount > 0 ? '已在「最近」置顶，并自动在阅读区打开。' : '没有成功导入的文献。'}
              </span>
              <button className="btn" onClick={onClose}>
                完成
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
