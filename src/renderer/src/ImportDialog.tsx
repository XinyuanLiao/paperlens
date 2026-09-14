import { useEffect, useRef, useState } from 'react'
import type { ImportOutcome, ImportPreviewItem } from './types'
import { catLabel } from './LibraryPane'

interface QueueItem {
  path: string
  name: string
  status: 'pending' | 'previewing' | 'ready' | 'working' | 'done' | 'failed'
  // 目标分类：'' = AI 自动推荐；'inbox' = 未分类；其余为分类名
  cat: string
  // AI 推荐原始值（tooltip 显示"AI 推荐，可修改"）
  aiRec?: string
  // 用户动过这行的选择后，迟到的预检结果不再覆盖
  touched?: boolean
  category?: string
  classified?: boolean
  error?: string
}

interface Props {
  initialFiles: string[]
  initialCats: string[]
  hasApiKey: boolean
  onBusyChange: (busy: boolean) => void
  onClose: () => void
  onFinished: (outcomes: ImportOutcome[]) => void
}

const NEW_CAT = '__new__'

// 导入弹窗：拖入 / 选文件 / 选文件夹 → AI 逐篇推荐分类（每行右侧可单独改）→ 确认导入
export default function ImportDialog({ initialFiles, initialCats, hasApiKey, onBusyChange, onClose, onFinished }: Props): JSX.Element {
  const [items, setItems] = useState<QueueItem[]>(() =>
    initialFiles
      .filter((p) => p.toLowerCase().endsWith('.pdf'))
      .map((p) => ({ path: p, name: p.replace(/.*[\\/]/, ''), status: 'pending' as const, cat: hasApiKey ? '' : 'inbox' }))
  )
  const [folders, setFolders] = useState<string[]>(() => initialFiles.filter((p) => !p.toLowerCase().endsWith('.pdf')))
  const [phase, setPhase] = useState<'idle' | 'importing' | 'done'>('idle')
  const [dragOver, setDragOver] = useState(false)
  const [cats, setCats] = useState<string[]>(initialCats)
  const [previewing, setPreviewing] = useState(false)
  // 行内「新建分类」：正在为第几行建分类 + 输入值
  const [newCatRow, setNewCatRow] = useState<number | null>(null)
  const [newCatVal, setNewCatVal] = useState('')
  const [newCatBusy, setNewCatBusy] = useState(false)
  const started = useRef(false)
  // 已预检过的路径（避免重复调 AI）
  const previewDone = useRef<Set<string>>(new Set())

  const defaultCat = (): string => (hasApiKey ? '' : 'inbox')

  // 预检：逐篇 AI 识别推荐分类；没连 AI 也跑（展开文件夹成行，分类默认未分类）
  const runPreview = (paths: string[]): void => {
    const todo = paths.filter((p) => !previewDone.current.has(p.toLowerCase()))
    if (todo.length === 0) return
    setPreviewing(true)
    void window.api
      .previewImport(todo)
      .then((rows) => {
        for (const r of rows) upsertPreview(r)
        todo.forEach((p) => previewDone.current.add(p.toLowerCase()))
      })
      .catch(() => undefined)
      .finally(() => setPreviewing(false))
  }

  const upsertPreview = (r: ImportPreviewItem): void => {
    setItems((its) => {
      const idx = its.findIndex((i) => i.path === r.path)
      const base: QueueItem = {
        path: r.path,
        name: r.file,
        status: r.ok ? 'ready' : 'failed',
        cat: r.ok && r.category ? r.category : 'inbox',
        aiRec: r.ok ? r.category : undefined,
        error: r.error
      }
      if (idx < 0) return [...its, base]
      const cur = its[idx]
      if (cur.touched || cur.status === 'done' || cur.status === 'working') return its
      const next = [...its]
      next[idx] = { ...cur, ...base, path: cur.path }
      return next
    })
    if (r.ok && r.category && r.category !== 'inbox') {
      setCats((cs) => (cs.some((c) => c.toLowerCase() === r.category!.toLowerCase()) ? cs : [...cs, r.category!]))
    }
  }

  useEffect(
    () =>
      window.api.onPreviewFile((p) => {
        upsertPreview(p)
      }),
    []
  )
  useEffect(
    () =>
      window.api.onPreviewProgress((p) => {
        if (!p.current) return
        setItems((its) => {
          const idx = its.findIndex((i) => i.name === p.current && (i.status === 'pending' || i.status === 'ready'))
          if (idx < 0) return its
          const next = [...its]
          next[idx] = { ...next[idx], status: 'previewing' }
          return next
        })
      }),
    []
  )

  const addPaths = (paths: string[]): void => {
    if (phase !== 'idle') return
    const pdfs = paths.filter((p) => p.toLowerCase().endsWith('.pdf'))
    const dirs = paths.filter((p) => !p.toLowerCase().endsWith('.pdf'))
    setItems((its) => {
      const seen = new Set(its.map((i) => i.path.toLowerCase()))
      return [...its, ...pdfs.filter((p) => p && !seen.has(p.toLowerCase())).map((p) => ({ path: p, name: p.replace(/.*[\\/]/, ''), status: 'pending' as const, cat: defaultCat() }))]
    })
    if (dirs.length) setFolders((fs) => [...fs, ...dirs.filter((d) => !fs.includes(d))])
    runPreview(paths) // 已预检过的路径会被 previewDone 过滤，重复路径由主进程展开去重
  }

  const pickFiles = async (): Promise<void> => {
    const paths = await window.api.pickImport()
    addPaths(paths)
  }
  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickImportFolder()
    if (dir) addPaths([dir])
  }

  const setRowCat = (i: number, cat: string): void => {
    setItems((its) => its.map((it, j) => (j === i ? { ...it, cat, touched: true } : it)))
  }
  const setAllCat = (cat: string): void => {
    setItems((its) => its.map((it) => (it.status === 'pending' || it.status === 'previewing' || it.status === 'ready' ? { ...it, cat, touched: true } : it)))
  }

  const createNewCatForRow = async (i: number): Promise<void> => {
    const name = newCatVal.trim()
    if (!name || newCatBusy) return
    setNewCatBusy(true)
    try {
      const r = await window.api.createCategory(name)
      setCats(await window.api.listCategories())
      setRowCat(i, r.name)
      setNewCatRow(null)
      setNewCatVal('')
    } catch (e) {
      alert(String(e))
    } finally {
      setNewCatBusy(false)
    }
  }

  // 逐篇结果事件：优先按完整路径匹配队列行（同名不同目录不错位），退回文件名
  useEffect(
    () =>
      window.api.onImportFile((o) => {
        setItems((its) => {
          const matchable = (i: QueueItem): boolean => i.status === 'pending' || i.status === 'previewing' || i.status === 'ready' || i.status === 'working'
          let idx = o.path ? its.findIndex((i) => i.path && i.path.toLowerCase() === o.path!.toLowerCase() && matchable(i)) : -1
          if (idx < 0) idx = its.findIndex((i) => i.name === o.file && matchable(i))
          const patch: Partial<QueueItem> = o.ok
            ? { status: 'done', category: o.category, classified: o.classified }
            : { status: 'failed', error: o.error }
          if (idx < 0) {
            return [...its, { path: o.path ?? '', name: o.file, status: 'done', cat: o.category ?? 'inbox', category: o.category, classified: o.classified }]
          }
          const next = [...its]
          next[idx] = { ...next[idx], ...patch }
          return next
        })
      }),
    []
  )
  // 当前导入到哪一篇（导入中高亮行）
  useEffect(
    () =>
      window.api.onImportProgress((p) => {
        if (!p.current) return
        setItems((its) => {
          const idx = its.findIndex((i) => i.name === p.current && (i.status === 'pending' || i.status === 'previewing' || i.status === 'ready'))
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
    // 每篇带着自己选的分类；剩余未展开的文件夹跟随 AI 自动
    const payload = [
      ...items.map((i) => ({ path: i.path, category: i.cat })),
      ...folders.filter((f) => !previewDone.current.has(f.toLowerCase())).map((f) => ({ path: f, category: '' }))
    ]
    void window.api
      .importPapers(payload)
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

  // 拖入文件直接开弹窗时：先跑预检展示推荐，不自动导入（用户确认分类后再点导入）
  useEffect(() => {
    if (initialFiles.length > 0) runPreview(initialFiles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doneCount = items.filter((i) => i.status === 'done' || i.status === 'failed').length
  const okCount = items.filter((i) => i.status === 'done').length
  const catSummary = (() => {
    const m = new Map<string, number>()
    for (const i of items) if (i.status === 'done' && i.category) m.set(i.category, (m.get(i.category) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${catLabel(c)} ×${n}`)
  })()
  const catOptions = cats.filter((c) => c !== 'inbox')

  const catSelect = (value: string, onChange: (v: string) => void, keyBase: string, title?: string): JSX.Element => (
    <select className="import-row-cat" value={value} title={title} onChange={(e) => onChange(e.target.value)}>
      {hasApiKey && (
        <option value="">AI 自动推荐</option>
      )}
      <option value="inbox">未分类</option>
      {catOptions.map((c) => (
        <option key={`${keyBase}-${c}`} value={c}>
          {catLabel(c)}
        </option>
      ))}
      <option value={NEW_CAT}>＋ 新建…</option>
    </select>
  )

  const onCatChange = (i: number, v: string): void => {
    if (v === NEW_CAT) {
      setNewCatRow(i)
      setNewCatVal('')
    } else {
      setRowCat(i, v)
      if (newCatRow === i) setNewCatRow(null)
    }
  }

  return (
    <div className="modal-mask" onMouseDown={phase === 'importing' ? undefined : onClose}>
      <div className="modal modal-pad import-modal" style={{ width: 560 }} onMouseDown={(e) => e.stopPropagation()}>
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
            <div className="import-drop-sub">支持多选，也可以整个文件夹</div>
            <div className="import-drop-actions">
              <button className="btn ghost" onClick={() => void pickFiles()}>
                选择文件…
              </button>
              <button className="btn ghost" onClick={() => void pickFolder()}>
                选择文件夹…
              </button>
            </div>
          </div>
        )}

        <div className="import-cat-hint">
          {hasApiKey
            ? 'AI 逐篇识别标题并推荐分类（每行右侧可单独修改），确认后点「导入」。'
            : '未连接 AI：默认放入未分类，可逐行选择目标分类。'}
        </div>

        {items.length > 0 && (
          <>
            {phase === 'idle' && items.length > 1 && (
              <div className="import-bulk">
                <span>全部设为</span>
                <select
                  className="import-row-cat"
                  value="__bulk__"
                  title="把下方所有待导入文献的分类一次设好（之后仍可单行调整）"
                  onChange={(e) => {
                    if (e.target.value && e.target.value !== '__bulk__' && e.target.value !== NEW_CAT) setAllCat(e.target.value)
                  }}
                >
                  <option value="__bulk__">选择分类…</option>
                  {catOptions.map((c) => (
                    <option key={`bulk-${c}`} value={c}>
                      {catLabel(c)}
                    </option>
                  ))}
                  <option value="inbox">未分类</option>
                </select>
              </div>
            )}
            <div className="import-queue">
              {folders.length > 0 && (
                <div className="import-row folder">
                  <span className="import-row-name ellipsis" title={folders.join('\n')}>
                    📁 {folders.length} 个文件夹{previewing ? '（识别中…）' : '（已展开为单篇）'}
                  </span>
                </div>
              )}
              {items.map((it, i) => (
                <div key={`${it.path}-${i}`} className={`import-row-wrap ${it.status}`}>
                  <div className={`import-row ${it.status}`}>
                    <span className="import-row-name ellipsis" title={it.path}>
                      {it.name}
                    </span>
                    {phase === 'idle' && it.status !== 'done' && (
                      <>
                        {it.status === 'previewing' && <span className="import-st working">识别中…</span>}
                        {it.status === 'ready' && it.aiRec && it.cat === it.aiRec && <span className="import-ai-tag" title="AI 推荐，可修改">AI</span>}
                        {it.status === 'failed' && (
                          <span className="import-st failed" title={it.error}>
                            识别失败
                          </span>
                        )}
                        {catSelect(it.cat, (v) => onCatChange(i, v), `r${i}`, it.aiRec && it.cat === it.aiRec ? `AI 推荐：${catLabel(it.aiRec)}` : undefined)}
                        <button className="import-row-x" title="移出队列" onClick={() => setItems((its) => its.filter((_, j) => j !== i))}>
                          ✕
                        </button>
                      </>
                    )}
                    {phase !== 'idle' && (it.status === 'pending' || it.status === 'previewing' || it.status === 'ready') && <span className="import-st pending">排队</span>}
                    {it.status === 'working' && <span className="import-st working">导入中…</span>}
                    {it.status === 'done' && (
                      <span className="import-st done" title={it.classified ? 'AI 自动归类' : '按所选分类导入'}>
                        ✓ {catLabel(it.category || 'inbox')}
                      </span>
                    )}
                    {phase !== 'idle' && it.status === 'failed' && (
                      <span className="import-st failed" title={it.error}>
                        失败
                      </span>
                    )}
                  </div>
                  {newCatRow === i && phase === 'idle' && (
                    <div className="import-newcat-row">
                      <input
                        autoFocus
                        placeholder="新分类名称（可用中文）"
                        value={newCatVal}
                        onChange={(e) => setNewCatVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void createNewCatForRow(i)
                        }}
                      />
                      <button className="btn" disabled={!newCatVal.trim() || newCatBusy} onClick={() => void createNewCatForRow(i)}>
                        创建并用它
                      </button>
                    </div>
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
                  {phase === 'importing' ? `导入中 ${doneCount}/${items.length}` : `完成：成功 ${okCount} · 失败 ${items.length - okCount}`}
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
                {previewing ? 'AI 逐篇识别中，可随时开始导入…' : '导入后自动建立索引，随后在阅读区打开。'}
              </span>
              <button className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button className="btn" disabled={items.length === 0 && folders.length === 0} onClick={start}>
                导入{items.length + folders.length > 0 ? ` ${items.length + folders.length} 项` : ''}
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
