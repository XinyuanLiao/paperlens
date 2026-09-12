import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import LibraryPane from './LibraryPane'
import PdfViewer, { type ViewerHandle } from './PdfViewer'
import SidePanel, { type SideControl } from './SidePanel'
import SettingsDialog from './SettingsDialog'
import SetupWizard from './SetupWizard'
import CommandPalette from './CommandPalette'
import ChatView from './ChatView'
import RefViewer from './RefViewer'
import type { ChatScope } from './ChatControls'
import type { Paper, Settings } from './types'

export interface Tab {
  paper: Paper
}

const SidebarIcon = (): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9 4v16" />
  </svg>
)
const PanelIcon = (): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M15 4v16" />
  </svg>
)
const GearIcon = (): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.12-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09A1.7 1.7 0 0 0 10.13 3V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z" />
  </svg>
)

type MenuItem = { label: string; hint?: string; action?: () => void; sep?: boolean }

const MenuBar = ({ menus, openMenu, setOpenMenu }: { menus: Array<{ name: string; items: MenuItem[] }>; openMenu: string | null; setOpenMenu: (m: string | null) => void }): JSX.Element => (
  <div className="app-menu">
    {menus.map((m) => (
      <div key={m.name} className="menu-wrap">
        <button
          className={`menu-btn ${openMenu === m.name ? 'on' : ''}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setOpenMenu(openMenu === m.name ? null : m.name)}
          onMouseEnter={() => openMenu && setOpenMenu(m.name)}
        >
          {m.name}
        </button>
        {openMenu === m.name && (
          <div className="menu-dropdown" onMouseDown={(e) => e.stopPropagation()}>
            {m.items.map((it, i) =>
              it.sep ? (
                <div key={i} className="menu-sep" />
              ) : (
                <button
                  key={i}
                  className="menu-item"
                  onClick={() => {
                    setOpenMenu(null)
                    it.action?.()
                  }}
                >
                  <span>{it.label}</span>
                  {it.hint && <span className="menu-hint">{it.hint}</span>}
                </button>
              )
            )}
          </div>
        )}
      </div>
    ))}
  </div>
)

const PROVIDER_LABEL: Record<string, string> = {
  zhipu: '智谱',
  deepseek: 'DeepSeek',
  qwen: '通义',
  moonshot: 'Kimi',
  openai: 'OpenAI',
  custom: '自定义'
}

export default function App(): JSX.Element {
  const [papers, setPapers] = useState<Paper[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [hist, setHist] = useState<number[]>([])
  const [hIdx, setHIdx] = useState(-1)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showLib, setShowLib] = useState(true)
  const [showSide, setShowSide] = useState(true)
  const [indexInfo, setIndexInfo] = useState<{ done: number; total: number; phase: string } | null>(null)
  const [classifyInfo, setClassifyInfo] = useState('')
  const [indexedCount, setIndexedCount] = useState({ papers: 0, indexed: 0, chunks: 0 })
  const [pendingJump, setPendingJump] = useState<{ slug: string; page: number } | null>(null)
  const [pageCtx, setPageCtx] = useState('')
  const [floatBar, setFloatBar] = useState<{ x: number; y: number; text: string } | null>(null)
  const [q, setQ] = useState('')
  const [llmChip, setLlmChip] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mode, setMode] = useState<'read' | 'chat'>('read')
  const isMac = /Mac/.test(navigator.platform)

  // 命令面板：Ctrl/Cmd + K 全局唤起
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const viewerRef = useRef<ViewerHandle>(null)
  const sideControl = useRef<SideControl>(null)
  const pageCtxRef = useRef('')

  const activePaper = tabs.find((t) => t.paper.id === activeId)?.paper ?? null

  useEffect(() => {
    if (!settings) return
    if (isMac) document.documentElement.classList.add('mac')
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      const t = settings.theme === 'system' ? (mq.matches ? 'light' : 'dark') : settings.theme
      document.documentElement.dataset.theme = t
      window.api.syncTheme(t)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings?.theme])

  const refreshPapers = useCallback(async () => {
    setPapers(await window.api.listPapers())
  }, [])

  const refreshLlmChip = useCallback(async () => {
    if (!settings?.apiKey) {
      setLlmChip('未连接')
      return
    }
    const r = await window.api.testLLM()
    if (r.ok) {
      const bal = r.balance ? ` · ${r.balance.currency === 'CNY' ? '¥' : r.balance.currency + ' '}${r.balance.amount}` : ''
      setLlmChip(`${r.model} · ${r.latencyMs}ms${bal}`)
    } else {
      setLlmChip('连接失败')
    }
  }, [settings?.apiKey, settings?.model, settings?.apiBase])

  useEffect(() => {
    void (async () => {
      setSettings(await window.api.getSettings())
      await refreshPapers()
      setIndexedCount(await window.api.indexStatus())
    })()
    const off = window.api.onIndexProgress((p) => {
      setIndexInfo(p)
      if (p.phase === 'done') {
        setIndexInfo(null)
        void window.api.indexStatus().then(setIndexedCount)
      }
    })
    const offCls = window.api.onClassifyProgress((p) => {
      if (p.error) setClassifyInfo(p.error)
      else if (p.total > 0 && p.done >= p.total) setClassifyInfo('')
      else if (p.total > 0) setClassifyInfo(`AI 归类中 ${p.done}/${p.total}`)
      else setClassifyInfo('')
    })
    const timer = setInterval(() => void window.api.indexStatus().then(setIndexedCount), 8000)
    return () => {
      off()
      offCls()
      clearInterval(timer)
    }
  }, [refreshPapers])

  useEffect(() => {
    void refreshLlmChip()
  }, [refreshLlmChip])

  // 打开论文并记录历史（前进/后退切换）
  const openPaper = useCallback(
    (p: Paper, jumpPage?: number) => {
      setTabs((ts) => (ts.some((t) => t.paper.id === p.id) ? ts : [...ts, { paper: p }]))
      setActiveId(p.id)
      setPendingJump(jumpPage ? { slug: p.slug, page: jumpPage } : null)
      setHist((h) => {
        const cut = h.slice(0, hIdx + 1)
        if (cut[cut.length - 1] === p.id) return cut
        cut.push(p.id)
        setHIdx(cut.length - 1)
        return cut
      })
    },
    [hIdx]
  )


  const closeTab = useCallback(
    (id: number) => {
      const idx = tabs.findIndex((t) => t.paper.id === id)
      const next = tabs.filter((t) => t.paper.id !== id)
      setTabs(next)
      if (id === activeId) setActiveId(next.length ? next[Math.min(idx, next.length - 1)].paper.id : null)
    },
    [tabs, activeId]
  )

  const cycleStatus = useCallback(async (p: Paper) => {
    const next = p.status === 'unread' ? 'reading' : p.status === 'reading' ? 'done' : 'unread'
    await window.api.setStatus(p.id, next)
    setPapers((ps) => ps.map((x) => (x.id === p.id ? { ...x, status: next } : x)))
    setTabs((ts) => ts.map((t) => (t.paper.id === p.id ? { ...t, paper: { ...p, status: next } } : t)))
  }, [])

  const onSelect = useCallback((text: string, x: number, y: number) => {
    setFloatBar({ x, y, text })
  }, [])
  const doHighlight = useCallback(() => {
    setFloatBar(null)
    void viewerRef.current?.highlightSelection()
  }, [])
  const doTranslate = useCallback((text: string) => {
    setFloatBar(null)
    setShowSide(true)
    sideControl.current?.translate(text, pageCtxRef.current)
  }, [])
  const doExplain = useCallback((text: string) => {
    setFloatBar(null)
    setShowSide(true)
    sideControl.current?.explain(text, pageCtxRef.current)
  }, [])
  const onDeleteHighlight = useCallback((hid: number) => {
    void window.api.deleteHighlight(hid)
    viewerRef.current?.removeHighlightLocal(hid)
  }, [])

  const importFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return
      setClassifyInfo(`导入中 ${paths.length} 篇…`)
      try {
        const { outcomes, scan } = await window.api.importPapers(paths)
        const ok = outcomes.filter((o) => o.ok)
        const ai = ok.filter((o) => o.classified).length
        setClassifyInfo(`导入 ${ok.length}/${paths.length}（AI 归类 ${ai}）`)
        await refreshPapers()
        void refreshLlmChip()
      } catch (e) {
        setClassifyInfo(`导入失败：${String(e)}`)
      }
      setTimeout(() => setClassifyInfo(''), 6000)
    },
    [refreshPapers, refreshLlmChip]
  )

  const addPapers = useCallback(async () => {
    const paths = await window.api.pickImport()
    await importFiles(paths)
  }, [importFiles])

  const reclassifyAll = useCallback(() => {
    setClassifyInfo('AI 归类中…')
    window.api.reclassifyAll()
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setFloatBar(null)
      const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean)
      void importFiles(paths)
    },
    [importFiles]
  )

  // 引用跳转 / 侧栏点开论文：都回到阅读模式
  const jumpTo = useCallback(
    (slug: string, page: number) => {
      const p = papers.find((x) => x.slug === slug)
      if (p) {
        setMode('read')
        openPaper(p, page)
      }
    },
    [papers, openPaper]
  )

  const openPaperFromTree = useCallback(
    (p: Paper) => {
      setMode('read')
      openPaper(p)
    },
    [openPaper]
  )

// 相对当前论文在排序列表中前后移动（而非浏览历史）
  const navBack = useCallback(() => {
    const idx = papers.findIndex((p) => p.id === activeId)
    if (idx > 0) openPaperFromTree(papers[idx - 1])
  }, [papers, activeId, openPaperFromTree])
  const navFwd = useCallback(() => {
    const idx = papers.findIndex((p) => p.id === activeId)
    if (idx >= 0 && idx < papers.length - 1) openPaperFromTree(papers[idx + 1])
  }, [papers, activeId, openPaperFromTree])

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const s = await window.api.saveSettings(patch)
    setSettings(s)
    return s
  }, [])

  const profiles = settings?.profiles ?? []
  const models = profiles.length ? profiles.flatMap((p) => p.models) : settings?.models?.length ? settings.models : settings?.model ? [settings.model] : []
  const model = settings?.model ?? ''
  const thinking = settings?.thinkingLevel ?? 'default'

  // 对话模式：检索范围与引用面板
  const [chatScope, setChatScope] = useState<ChatScope>({ type: 'all', cat: '' })
  const [refView, setRefView] = useState<{ paper: Paper; page: number } | null>(null)
  const [refWidth, setRefWidth] = useState(() => Number(localStorage.getItem('pl.refW')) || 460)
  const cats = useMemo(() => [...new Set(papers.map((p) => p.category))].sort((a, b) => a.localeCompare(b)), [papers])
  const catCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of papers) m.set(p.category, (m.get(p.category) ?? 0) + 1)
    return m
  }, [papers])
  // Chat 模式点引用：在右侧引用面板打开，不离开对话
  const openCite = useCallback(
    (slug: string, page: number) => {
      const p = papers.find((x) => x.slug === slug)
      if (p) setRefView({ paper: p, page })
    },
    [papers]
  )
  const changeModel = useCallback(
    (m: string) => {
      // 跨供应商：该模型属于哪个配置，就同步切换到那个供应商
      const pf = profiles.find((p) => p.models.includes(m))
      if (pf) void saveSettings({ model: m, provider: pf.provider, apiBase: pf.apiBase, apiKey: pf.apiKey })
      else void saveSettings({ model: m })
    },
    [profiles, saveSettings]
  )
  const changeThinking = useCallback(
    (l: string) => {
      void saveSettings({ thinkingLevel: l as Settings['thinkingLevel'] })
    },
    [saveSettings]
  )

  // 侧栏无级拖宽（宽度记忆在 localStorage）
  const [libWidth, setLibWidth] = useState(() => Number(localStorage.getItem('pl.libW')) || 264)
  const [sideWidth, setSideWidth] = useState(() => Number(localStorage.getItem('pl.sideW')) || 380)
  const startDrag = useCallback((which: 'lib' | 'side' | 'ref') => (e: React.MouseEvent) => {
    e.preventDefault()
    const key = which === 'lib' ? 'pl.libW' : which === 'side' ? 'pl.sideW' : 'pl.refW'
    const startX = e.clientX
    const startW = Number(localStorage.getItem(key)) || (which === 'lib' ? 264 : which === 'side' ? 380 : 460)
    const move = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX
      // lib 把手在右缘（右拖变宽）；side/ref 把手在左缘（左拖变宽）
      const w = which === 'lib' ? startW + dx : startW - dx
      const min = which === 'lib' ? 200 : 300
      const max = which === 'lib' ? 480 : which === 'side' ? 680 : 900
      const clamped = Math.max(min, Math.min(max, w))
      if (which === 'lib') setLibWidth(clamped)
      else if (which === 'side') setSideWidth(clamped)
      else setRefWidth(clamped)
      localStorage.setItem(key, String(clamped))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  // 文件菜单 / 空库引导：直接选库文件夹并扫描（与设置页同效）
  const pickLibraryNow = useCallback(async () => {
    const p = await window.api.pickLibrary()
    if (!p) return
    const s = await saveSettings({ libraryPath: p })
    await window.api.scanLibrary(s.libraryPath)
    await refreshPapers()
  }, [saveSettings, refreshPapers])

  const statusLeft = classifyInfo || (indexInfo ? `正在索引 ${indexInfo.done}/${indexInfo.total}` : `已索引 ${indexedCount.indexed}/${indexedCount.papers} 篇 · ${indexedCount.chunks} 块`)
  const curIdx = papers.findIndex((p) => p.id === activeId)
  const canBack = curIdx > 0
  const canFwd = curIdx >= 0 && curIdx < papers.length - 1

  // 首次启动：走完「文献库 → LLM → 嵌入」向导才进主界面（已有文献库的老用户自动跳过）
  if (settings && !settings.setupDone && papers.length === 0) {
    return (
      <SetupWizard
        initial={settings}
        onDone={() => {
          void (async () => {
            setSettings(await window.api.getSettings())
            await refreshPapers()
            setIndexedCount(await window.api.indexStatus())
          })()
        }}
      />
    )
  }

  const menus = [
    {
      name: '文件',
      items: [
        { label: '导入 PDF 文献…', hint: '拖入窗口也可以', action: addPapers },
        { label: '选择文献库文件夹…', action: () => void pickLibraryNow() },
        { label: '重建全库索引', action: () => void window.api.rebuildIndex() },
        { sep: true, label: '' },
        { label: '设置…', action: () => setShowSettings(true) },
        { label: '退出', action: () => window.close() }
      ] as MenuItem[]
    },
    {
      name: '视图',
      items: [
        { label: '命令面板…', hint: isMac ? '⌘K' : 'Ctrl+K', action: () => setPaletteOpen(true) },
        { sep: true, label: '' },
        { label: showLib ? '隐藏文献侧栏' : '显示文献侧栏', action: () => setShowLib((v) => !v) },
        { label: showSide ? '隐藏问答面板' : '显示问答面板', action: () => setShowSide((v) => !v) },
        { sep: true, label: '' },
        { label: '放大', hint: isMac ? '⌘ +' : 'Ctrl +', action: () => viewerRef.current?.zoomBy(0.15) },
        { label: '缩小', hint: isMac ? '⌘ -' : 'Ctrl -', action: () => viewerRef.current?.zoomBy(-0.15) },
        { label: '适应宽度', hint: isMac ? '⌘ 0' : 'Ctrl 0', action: () => viewerRef.current?.zoomReset() },
        { sep: true, label: '' },
        { label: '重新加载', hint: isMac ? '⌘ R' : 'Ctrl R', action: () => location.reload() }
      ] as MenuItem[]
    },
    {
      name: '帮助',
      items: [
        { label: '命令面板…', hint: isMac ? '⌘K' : 'Ctrl+K', action: () => setPaletteOpen(true) },
        { label: 'GitHub 仓库', action: () => window.api.openExternal('https://github.com/XinyuanLiao/paperlens') }
      ] as MenuItem[]
    }
  ]

  return (
    <div
      className="shell"
      onMouseDown={() => {
        setFloatBar(null)
        setOpenMenu(null)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="titlebar">
        {!isMac && (
          <MenuBar menus={menus} openMenu={openMenu} setOpenMenu={setOpenMenu} />
        )}
        <div className="tb-side tb-left">
          <button className={`icon-btn ${showLib ? 'on' : ''}`} title="显示/隐藏 侧栏" onClick={() => setShowLib((v) => !v)}>
            <SidebarIcon />
          </button>
        </div>
        <div className="tb-drag" />
        <div className="tb-title">PaperLens</div>
        <div className="tb-drag" />
        <div className="tb-side tb-right">
          {mode === 'read' && (
            <button className={`icon-btn ${showSide ? 'on' : ''}`} title="显示/隐藏 问答·翻译" onClick={() => setShowSide((v) => !v)}>
              <PanelIcon />
            </button>
          )}
          <button className="icon-btn" title="设置" onClick={() => setShowSettings(true)}>
            <GearIcon />
          </button>
        </div>
      </div>

      <div className="body3">
        {showLib && (
          <>
            <LibraryPane
              width={libWidth}
              papers={papers}
              activeId={activeId}
              q={q}
              onSetQ={setQ}
              onOpen={openPaperFromTree}
              onCycleStatus={cycleStatus}
              onAddPapers={addPapers}
              onReindex={() => {
                void window.api.rebuildIndex()
              }}
              onReclassify={reclassifyAll}
              onBack={navBack}
              onFwd={navFwd}
              canBack={canBack}
              canFwd={canFwd}
              onOpenPalette={() => setPaletteOpen(true)}
              mode={mode}
              onModeChange={setMode}
              onPapersChanged={refreshPapers}
            />
            <div className="col-resizer" onMouseDown={startDrag('lib')} title="拖动调节宽度，双击复位" onDoubleClick={() => { setLibWidth(264); localStorage.setItem('pl.libW', '264') }} />
          </>
        )}
        <div className="workspace">
          {/* 阅读区：模式切换只隐藏不卸载，保留标签页与滚动状态 */}
          <div className={`main-win ${mode === 'read' ? '' : 'pane-hidden'}`}>
            {tabs.length === 0 ? (
              <div className="start-pane">
                <div className="workspace-empty">
                  <div className="big">📚</div>
                  <div className="headline">PaperLens</div>
                  <div className="tip">从左侧选择论文开始阅读；对话模式可与全库文献直接对话</div>
                  {papers.length === 0 && (
                    <div className="empty-actions">
                      <button className="add-btn" onClick={() => void pickLibraryNow()}>
                        选择文献库文件夹
                      </button>
                      <button className="add-btn ghost" onClick={addPapers}>
                        导入 PDF 文献
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <PdfViewer
                ref={viewerRef}
                tabs={tabs}
                activeId={activeId}
                onActivate={setActiveId}
                onCloseTab={closeTab}
                pendingJump={pendingJump}
                onJumped={() => setPendingJump(null)}
                onPageContext={(t) => {
                  pageCtxRef.current = t
                  setPageCtx(t)
                }}
                onSelect={onSelect}
                onDeleteHighlight={onDeleteHighlight}
              />
            )}
            {showSide && (
              <div
                className="col-resizer"
                onMouseDown={startDrag('side')}
                title="拖动调节宽度，双击复位"
                onDoubleClick={() => {
                  setSideWidth(380)
                  localStorage.setItem('pl.sideW', '380')
                }}
              />
            )}
            {/* 问答面板常驻：隐藏时保留聊天与翻译记录 */}
            <div className={`side-wrap ${showSide ? '' : 'pane-hidden'}`}>
              <SidePanel
                ref={sideControl}
                width={sideWidth}
                paper={activePaper}
                pageContext={pageCtx}
                onJump={jumpTo}
                models={models}
                model={model}
                thinking={thinking}
                onChangeModel={changeModel}
                onChangeThinking={changeThinking}
              />
            </div>
          </div>
          {/* 对话区：同样常驻，保留对话历史 */}
          <div className={`chat-wrap ${mode === 'chat' ? '' : 'pane-hidden'}`}>
            <ChatView
              paperCount={papers.length}
              cats={cats}
              catCounts={catCounts}
              scope={chatScope}
              onScopeChange={setChatScope}
              models={models}
              model={model}
              thinking={thinking}
              onChangeModel={changeModel}
              onChangeThinking={changeThinking}
              onJump={openCite}
            />
            {refView && (
              <>
                <div
                  className="col-resizer"
                  onMouseDown={startDrag('ref')}
                  title="拖动调节宽度，双击复位"
                  onDoubleClick={() => {
                    setRefWidth(460)
                    localStorage.setItem('pl.refW', '460')
                  }}
                />
                <RefViewer paper={refView.paper} page={refView.page} width={refWidth} onClose={() => setRefView(null)} />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="statusbar">
        <span className="ellipsis">{statusLeft}</span>
        <span style={{ flex: 1 }} />
        <span className="chip" title="向量嵌入">
          {settings?.embedProvider === 'ollama' ? `嵌入 ${settings.ollamaEmbedModel}` : settings?.embedProvider === 'zhipu' ? '嵌入 embedding-3' : '嵌入本地 e5'}
        </span>
        <span className="chip" title={llmChip} onClick={() => void refreshLlmChip()}>
          {llmChip || `${settings?.model ?? ''}${settings ? ` · ${PROVIDER_LABEL[settings.provider] ?? ''}` : ''}`}
        </span>
      </div>

      {floatBar && (
        <div
          className="float-bar"
          style={{ left: Math.min(floatBar.x, window.innerWidth - 210), top: Math.min(floatBar.y + 8, window.innerHeight - 50) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={doHighlight}>高亮</button>
          <button onClick={() => doTranslate(floatBar.text)}>翻译</button>
          <button onClick={() => doExplain(floatBar.text)}>解释</button>
        </div>
      )}
      {showSettings && settings && (
        <SettingsDialog settings={settings} indexed={indexedCount} indexInfo={indexInfo} onSave={saveSettings} onRescanned={refreshPapers} onClose={() => setShowSettings(false)} />
      )}
      {paletteOpen && (
        <CommandPalette
          papers={papers}
          onClose={() => setPaletteOpen(false)}
          onOpenPaper={openPaper}
          commands={[
            { id: 'add', label: '导入 PDF 文献…', hint: '文件', run: addPapers },
            { id: 'picklib', label: '选择文献库文件夹…', hint: '文件', run: () => void pickLibraryNow() },
            { id: 'reindex', label: '重建全库索引', hint: '文件', run: () => void window.api.rebuildIndex() },
            { id: 'reclassify', label: 'AI 重新归类全部文献', hint: '文件', run: reclassifyAll },
            { id: 'settings', label: '打开设置…', hint: '界面', run: () => setShowSettings(true) },
            { id: 'theme', label: '切换 深色/浅色 主题', hint: '界面', run: () => void saveSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }) },
            { id: 'sidebar', label: showLib ? '隐藏文献侧栏' : '显示文献侧栏', hint: '视图', run: () => setShowLib((v) => !v) },
            { id: 'panel', label: showSide ? '隐藏问答面板' : '显示问答面板', hint: '视图', run: () => setShowSide((v) => !v) },
            { id: 'reload', label: '重新加载窗口', hint: '视图', run: () => location.reload() }
          ]}
        />
      )}
    </div>
  )
}
