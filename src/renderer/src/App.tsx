import { useCallback, useEffect, useRef, useState } from 'react'
import LibraryPane from './LibraryPane'
import PdfViewer, { type ViewerHandle } from './PdfViewer'
import SidePanel, { type SideControl } from './SidePanel'
import SettingsDialog from './SettingsDialog'
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

  const viewerRef = useRef<ViewerHandle>(null)
  const sideControl = useRef<SideControl>(null)
  const pageCtxRef = useRef('')

  const activePaper = tabs.find((t) => t.paper.id === activeId)?.paper ?? null

  useEffect(() => {
    if (!settings) return
    if (/Mac/.test(navigator.platform)) document.documentElement.classList.add('mac')
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      const t = settings.theme === 'system' ? (mq.matches ? 'light' : 'dark') : settings.theme
      document.documentElement.dataset.theme = t
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

  const navBack = useCallback(() => {
    if (hIdx > 0) {
      setHIdx(hIdx - 1)
      setActiveId(hist[hIdx - 1])
    }
  }, [hist, hIdx])
  const navFwd = useCallback(() => {
    if (hIdx < hist.length - 1) {
      setHIdx(hIdx + 1)
      setActiveId(hist[hIdx + 1])
    }
  }, [hist, hIdx])

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
    sideControl.current?.translate(text, pageCtxRef.current)
  }, [])
  const doExplain = useCallback((text: string) => {
    setFloatBar(null)
    sideControl.current?.explain(text, pageCtxRef.current)
  }, [])
  const doQuote = useCallback((text: string) => {
    setFloatBar(null)
    sideControl.current?.quote(text)
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

  const jumpTo = useCallback(
    (slug: string, page: number) => {
      const p = papers.find((x) => x.slug === slug)
      if (p) openPaper(p, page)
    },
    [papers, openPaper]
  )

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const s = await window.api.saveSettings(patch)
    setSettings(s)
    return s
  }, [])

  const statusLeft = classifyInfo || (indexInfo ? `正在索引 ${indexInfo.done}/${indexInfo.total}` : `已索引 ${indexedCount.indexed}/${indexedCount.papers} 篇 · ${indexedCount.chunks} 块`)
  const canBack = hIdx > 0
  const canFwd = hIdx < hist.length - 1

  return (
    <div className="shell" onMouseDown={() => setFloatBar(null)} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="titlebar">
        <div className="tb-side tb-left">
          <button className={`icon-btn ${showLib ? 'on' : ''}`} title="显示/隐藏 侧栏" onClick={() => setShowLib((v) => !v)}>
            <SidebarIcon />
          </button>
        </div>
        <div className="tb-drag" />
        <div className="tb-side tb-right">
          <button className={`icon-btn ${showSide ? 'on' : ''}`} title="显示/隐藏 问答·翻译" onClick={() => setShowSide((v) => !v)}>
            <PanelIcon />
          </button>
          <button className="icon-btn" title="设置" onClick={() => setShowSettings(true)}>
            <GearIcon />
          </button>
        </div>
      </div>

      <div className="body3">
        {showLib && (
          <LibraryPane
            papers={papers}
            activeId={activeId}
            q={q}
            onSetQ={setQ}
            onOpen={openPaper}
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
          />
        )}
        <div className="workspace">
          {tabs.length === 0 ? (
            <div className="workspace-empty">
              <div className="big">📚</div>
              <div className="headline">PaperLens</div>
              <div className="tip">从左侧选择论文，或添加新的文献</div>
            </div>
          ) : (
            <div className={`float-win ${showSide ? 'with-side' : ''}`}>
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
              {showSide && <SidePanel ref={sideControl} paper={activePaper} pageContext={pageCtx} onJump={jumpTo} />}
            </div>
          )}
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
          <button onClick={() => doQuote(floatBar.text)}>追问</button>
        </div>
      )}
      {showSettings && settings && (
        <SettingsDialog settings={settings} indexed={indexedCount} indexInfo={indexInfo} onSave={saveSettings} onRescanned={refreshPapers} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}
