import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import LibraryPane from './LibraryPane'
import PdfViewer, { type ViewerHandle } from './PdfViewer'
import SidePanel, { type SideControl } from './SidePanel'
import SettingsDialog from './SettingsDialog'
import SetupWizard from './SetupWizard'
import CommandPalette from './CommandPalette'
import ChatView from './ChatView'
import ImportDialog from './ImportDialog'
import type { ChatScope } from './ChatControls'
import type { ChatMeta, Paper, Settings } from './types'

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
  mimo: '小米 MiMo',
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
  // 右侧问答面板默认收起：阅读空间优先，顶栏/视图菜单可再打开
  // 阅读模式的问答·翻译侧栏默认展开（划词翻译在启动首屏即可用）
  const [showSide, setShowSide] = useState(true)
  const [indexInfo, setIndexInfo] = useState<{ done: number; total: number; phase: string } | null>(null)
  const [importInfo, setImportInfo] = useState('')
  const [cats, setCats] = useState<string[]>([])
  const [importFiles, setImportFiles] = useState<string[] | null>(null)
  const [importSeq, setImportSeq] = useState(0)
  const [importBusy, setImportBusy] = useState(false)
  // 对话历史：列表 + 当前打开的会话（null = 新对话）
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [curChatId, setCurChatId] = useState<number | null>(null)
  const [indexedCount, setIndexedCount] = useState({ papers: 0, indexed: 0, chunks: 0 })
  const [pendingJump, setPendingJump] = useState<{ slug: string; page: number; snippet?: string; probe?: string } | null>(null)
  const [pageCtx, setPageCtx] = useState('')
  const [floatBar, setFloatBar] = useState<{ x: number; y: number; text: string; copied?: boolean } | null>(null)
  const [q, setQ] = useState('')
  const [llmChip, setLlmChip] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mode, setMode] = useState<'read' | 'chat'>('read')
  // 切换模式后搜索框重置：侧栏搜索在阅读模式过滤论文、对话模式过滤历史对话，语义不同不延续
  useEffect(() => {
    setQ('')
  }, [mode])
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

  // 全局字体（设置 → 通用）：默认走界面字型栈（内置 Inter 无衬线 + 中文宋体）；
  // 用户显式选择字体时其西文优先，中文仍落到宋体栈（选中的字体若自带中文则以其为准，属用户显式选择）
  useEffect(() => {
    const cjk = `'Songti SC', SimSun, 'STZhongsong', 'Source Han Serif SC', 'Noto Serif CJK SC', serif`
    document.body.style.fontFamily = settings?.fontFamily
      ? `"${settings.fontFamily.replace(/["']/g, '')}", ${cjk}`
      : `'Inter Variable', 'Inter', 'Segoe UI', ${cjk}, system-ui, sans-serif`
  }, [settings?.fontFamily])

  // 刷新文献与分类列表；同时把打开的标签页/引用面板里的旧 paper 对象换成最新数据
  //（手动移动/重命名后 path 变了，不同步的话下次打开会读到失效路径）；已删除的论文同步关掉标签页/引用面板
  const refreshPapers = useCallback(async (): Promise<Paper[]> => {
    const [ps, cs] = await Promise.all([window.api.listPapers(), window.api.listCategories()])
    setPapers(ps)
    setCats(cs)
    setTabs((ts) => {
      const next: Tab[] = []
      for (const t of ts) {
        const fresh = ps.find((p) => p.id === t.paper.id)
        if (fresh) next.push({ paper: fresh })
      }
      return next
    })
    return ps
  }, [])

  // 被删除论文的标签页收起后，激活标签落到列表末位（无标签则清空）
  useEffect(() => {
    if (activeId !== null && !tabs.some((t) => t.paper.id === activeId)) {
      setActiveId(tabs.length ? tabs[tabs.length - 1].paper.id : null)
    }
  }, [tabs, activeId])

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
    // 导入进度（状态栏）：弹窗关闭时也能看到后台导入到哪了
    const offImp = window.api.onImportProgress((p) => {
      if (p.total > 0 && p.done < p.total) setImportInfo(`导入中 ${p.done}/${p.total}`)
      else setImportInfo('')
    })
    // 主进程菜单触发的变更（右键移动/删除空分类）与导入入口
    const offChg = window.api.onPapersChanged(() => void refreshPapers())
    const offReq = window.api.onImportRequest(() => {
      if (!importBusy) {
        setImportFiles([])
        setImportSeq((s) => s + 1)
      }
    })
    const timer = setInterval(() => void window.api.indexStatus().then(setIndexedCount), 8000)
    return () => {
      off()
      offImp()
      offChg()
      offReq()
      clearInterval(timer)
    }
  }, [refreshPapers])

  useEffect(() => {
    void refreshLlmChip()
  }, [refreshLlmChip])

  // 打开论文并记录历史（前进/后退切换）；probe = 问题+回答上下文，引用跳转的关键词定位用
  const openPaper = useCallback(
    (p: Paper, jumpPage?: number, snippet?: string, probe?: string) => {
      setTabs((ts) => (ts.some((t) => t.paper.id === p.id) ? ts : [...ts, { paper: p }]))
      setActiveId(p.id)
      setPendingJump(jumpPage ? { slug: p.slug, page: jumpPage, snippet, probe } : null)
      // 「最近」视图排序依据：与 sqlite datetime('now') 同格式（UTC）
      void window.api.markOpened(p.id)
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
      setPapers((ps) => ps.map((x) => (x.id === p.id ? { ...x, opened_at: now } : x)))
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
  // 复制选中文本：按钮短暂变「已复制」再收起浮条，给用户操作成功的反馈
  const doCopy = useCallback((text: string) => {
    void navigator.clipboard
      .writeText(text)
      .catch(() => {})
      .finally(() => {
        setFloatBar((f) => (f ? { ...f, copied: true } : f))
        setTimeout(() => setFloatBar(null), 450)
      })
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

  // 导入走弹窗（拖入窗口 = 直接带着文件打开并自动开始；导入进行中忽略新的窗口拖入）
  const addPapers = useCallback(() => {
    setImportFiles([])
    setImportSeq((s) => s + 1)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setFloatBar(null)
      if (importBusy) return
      const paths = [...e.dataTransfer.files]
        .map((f) => window.api.pathForFile(f))
        .filter(Boolean)
        .filter((p) => p.toLowerCase().endsWith('.pdf'))
      if (paths.length > 0) {
        setImportFiles(paths)
        setImportSeq((s) => s + 1)
      }
    },
    [importBusy]
  )

  // 引用跳转 / 侧栏点开论文：都回到阅读模式
  const jumpTo = useCallback(
    (slug: string, page: number, snippet?: string, probe?: string) => {
      const p = papers.find((x) => x.slug === slug)
      if (p) {
        setMode('read')
        openPaper(p, page, snippet, probe)
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

  // 参考文献弹窗导入完成后打开新入库的论文（先刷新拿最新 paper 对象）
  const openPaperBySlug = useCallback(
    async (slug: string) => {
      const ps = await refreshPapers()
      const p = ps.find((x) => x.slug === slug)
      if (p) openPaperFromTree(p)
    },
    [refreshPapers, openPaperFromTree]
  )

  // 导入完成后刷新并自动在阅读区打开第一篇成功导入的论文
  const importDone = useCallback(
    async (outcomes: { ok: boolean; slug?: string }[]) => {
      const ps = await refreshPapers()
      const first = outcomes.find((o) => o.ok && o.slug)
      if (first?.slug) {
        const p = ps.find((x) => x.slug === first.slug)
        if (p) openPaperFromTree(p)
      }
      setImportBusy(false)
    },
    [refreshPapers, openPaperFromTree]
  )

  // 对话历史：列表刷新（新建/追加/改名/删除后由 ChatView 回调触发；进对话模式时也刷一次）
  const refreshChats = useCallback(async (): Promise<void> => {
    setChats(await window.api.chatsList())
  }, [])
  useEffect(() => {
    void refreshChats()
  }, [refreshChats])
  useEffect(() => {
    if (mode === 'chat') void refreshChats()
  }, [mode, refreshChats])

  // 新建对话：当前会话已增量落库（自动归档），直接切换到空白新会话
  const newChat = useCallback(() => {
    setMode('chat')
    setCurChatId(null)
  }, [])
  const openChat = useCallback((id: number) => {
    setMode('chat')
    setCurChatId(id)
  }, [])
  const deleteChat = useCallback(
    async (id: number) => {
      await window.api.chatDelete(id)
      setCurChatId((c) => (c === id ? null : c))
      await refreshChats()
    },
    [refreshChats]
  )
  const renameChat = useCallback(
    async (id: number, title: string) => {
      await window.api.chatRename(id, title)
      await refreshChats()
    },
    [refreshChats]
  )

  // 手动归类（拖拽 / 弹窗）：移动文件夹 + 刷新
  const movePaper = useCallback(
    async (id: number, cat: string) => {
      try {
        await window.api.movePaper(id, cat)
        await refreshPapers()
      } catch (e) {
        alert(String(e))
      }
    },
    [refreshPapers]
  )

  // 勾选文献 → 对话检索范围（跳到对话模式，输入框上方显示所选）
  const [chatPicks, setChatPicks] = useState<Paper[]>([])
  const addPicksToChat = useCallback((ps: Paper[]): void => {
    if (!ps.length) return
    setChatPicks(ps)
    setMode('chat')
  }, [])

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    const s = await window.api.saveSettings(patch)
    setSettings(s)
    return s
  }, [])

  const profiles = settings?.profiles ?? []
  const models = profiles.length ? profiles.flatMap((p) => p.models) : settings?.models?.length ? settings.models : settings?.model ? [settings.model] : []
  const model = settings?.model ?? ''
  const thinkingOn = (settings?.thinkingLevel ?? 'on') !== 'off'

  // 对话模式：检索范围（点引用芯片直接跳阅读模式对应位置）
  const [chatScope, setChatScope] = useState<ChatScope>({ type: 'all', cat: '' })

  // 对话字号（问答/翻译/对话三处共用），CSS 变量 --chat-fs 驱动，localStorage 记忆
  const [chatFs, setChatFs] = useState(() => Math.max(11, Math.min(19, Number(localStorage.getItem('pl.chatFs')) || 13)))
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-fs', `${chatFs}px`)
  }, [chatFs])
  const changeFs = useCallback((d: number) => {
    setChatFs((f) => {
      const n = Math.max(11, Math.min(19, f + d))
      localStorage.setItem('pl.chatFs', String(n))
      return n
    })
  }, [])
  const resetFs = useCallback(() => {
    localStorage.setItem('pl.chatFs', '13')
    setChatFs(13)
  }, [])

  const catCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of papers) m.set(p.category, (m.get(p.category) ?? 0) + 1)
    return m
  }, [papers])
  const changeModel = useCallback(
    (m: string) => {
      // 跨供应商：该模型属于哪个配置，就同步切换到那个供应商
      const pf = profiles.find((p) => p.models.includes(m))
      if (pf) void saveSettings({ model: m, provider: pf.provider, apiBase: pf.apiBase, apiKey: pf.apiKey })
      else void saveSettings({ model: m })
    },
    [profiles, saveSettings]
  )
  const changeThinkingOn = useCallback(
    (v: boolean) => {
      void saveSettings({ thinkingLevel: v ? 'on' : 'off' })
    },
    [saveSettings]
  )

  // 侧栏无级拖宽（宽度记忆在 localStorage）
  const [libWidth, setLibWidth] = useState(() => Math.max(258, Number(localStorage.getItem('pl.libW')) || 264))
  // 右侧问答栏最小 360px：再窄控件文字会被挤断行/变形
  const [sideWidth, setSideWidth] = useState(() => Math.max(360, Number(localStorage.getItem('pl.sideW')) || 380))
  const startDrag = useCallback((which: 'lib' | 'side' | 'ref') => (e: React.MouseEvent) => {
    e.preventDefault()
    const key = which === 'lib' ? 'pl.libW' : which === 'side' ? 'pl.sideW' : 'pl.refW'
    const startX = e.clientX
    const startW = Number(localStorage.getItem(key)) || (which === 'lib' ? 264 : which === 'side' ? 380 : 460)
    const move = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX
      // lib 把手在右缘（右拖变宽）；side 把手在左缘（左拖变宽）
      const w = which === 'lib' ? startW + dx : startW - dx
      const min = which === 'lib' ? 258 : 360
      const max = which === 'lib' ? 480 : 680
      const clamped = Math.max(min, Math.min(max, w))
      if (which === 'lib') setLibWidth(clamped)
      else setSideWidth(clamped)
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

  const statusLeft = importInfo || (indexInfo ? `正在索引 ${indexInfo.done}/${indexInfo.total}` : `已索引 ${indexedCount.indexed}/${indexedCount.papers} 篇 · ${indexedCount.chunks} 块`)

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
        { label: '增大对话字号', hint: '问答/翻译/对话', action: () => changeFs(1) },
        { label: '减小对话字号', hint: '问答/翻译/对话', action: () => changeFs(-1) },
        { label: '重置对话字号', hint: '13px', action: resetFs },
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
        </div>
      </div>

      <div className="body3">
        {showLib && (
          <>
            <LibraryPane
              width={libWidth}
              papers={papers}
              cats={cats}
              activeId={activeId}
              q={q}
              onSetQ={setQ}
              onOpen={openPaperFromTree}
              onCycleStatus={cycleStatus}
              onAddPapers={addPapers}
              onNewChat={newChat}
              onAddPicks={addPicksToChat}
              chats={chats}
              curChatId={curChatId}
              onOpenChat={openChat}
              onDeleteChat={(id) => void deleteChat(id)}
              onRenameChat={(id, title) => void renameChat(id, title)}
              onMovePaper={(id, cat) => void movePaper(id, cat)}
              onReindex={() => {
                void window.api.rebuildIndex()
              }}
              onRescan={() => {
                void (async () => {
                  await window.api.scanLibrary()
                  await refreshPapers()
                })()
              }}
              onOpenPalette={() => setPaletteOpen(true)}
              onOpenSettings={() => setShowSettings(true)}
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
                  <div className="big-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 6c-1.8-1.6-4.2-2-8-2v14c3.8 0 6.2.4 8 2 1.8-1.6 4.2-2 8-2V4c-3.8 0-6.2.4-8 2z" />
                      <path d="M12 6v14" />
                    </svg>
                  </div>
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
                visible={mode === 'read'}
                papers={papers}
                onOpenPaperBySlug={(slug) => void openPaperBySlug(slug)}
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
                thinkingOn={thinkingOn}
                onChangeModel={changeModel}
                onChangeThinkingOn={changeThinkingOn}
                fs={chatFs}
                onFs={changeFs}
              />
            </div>
          </div>
          {/* 对话区：同样常驻，保留对话历史 */}
          <div className={`chat-wrap ${mode === 'chat' ? '' : 'pane-hidden'}`}>
            <ChatView
              papers={papers}
              paperCount={papers.length}
              cats={cats}
              catCounts={catCounts}
              scope={chatScope}
              onScopeChange={setChatScope}
              models={models}
              model={model}
              thinkingOn={thinkingOn}
              onChangeModel={changeModel}
              onChangeThinkingOn={changeThinkingOn}
              onJump={jumpTo}
              activeChatId={curChatId}
              onChatStarted={setCurChatId}
              onChatsChanged={() => void refreshChats()}
              picks={chatPicks}
              onRemovePick={(id) => setChatPicks((l) => l.filter((p) => p.id !== id))}
              onClearPicks={() => setChatPicks([])}
              onRepick={() => setMode('read')}
              fs={chatFs}
              onFs={changeFs}
            />
          </div>
        </div>
      </div>

      <div className="statusbar">
        <span className="ellipsis">{statusLeft}</span>
        <span style={{ flex: 1 }} />
        <span className="chip" title={llmChip} onClick={() => void refreshLlmChip()}>
          {llmChip || `${settings?.model ?? ''}${settings ? ` · ${PROVIDER_LABEL[settings.provider] ?? ''}` : ''}`}
        </span>
      </div>

      {floatBar && (
        <div
          className={`float-bar ${floatBar.copied ? 'copied' : ''}`}
          style={{
            left: Math.max(8, Math.min(floatBar.x, window.innerWidth - 238)),
            top: Math.max(8, Math.min(floatBar.y, window.innerHeight - 52))
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button onClick={doHighlight}>高亮</button>
          <button onClick={() => doCopy(floatBar.text)}>{floatBar.copied ? '已复制' : '复制'}</button>
          <button onClick={() => doExplain(floatBar.text)}>解释</button>
          <button className="fb-accent" onClick={() => doTranslate(floatBar.text)}>翻译</button>
        </div>
      )}
      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          indexed={indexedCount}
          indexInfo={indexInfo}
          onSave={saveSettings}
          onRescanned={refreshPapers}
          onClose={() => setShowSettings(false)}
          chatFs={chatFs}
          onChatFs={changeFs}
          onChatFsReset={resetFs}
        />
      )}
      {importFiles !== null && settings && (
        <ImportDialog
          key={importSeq}
          initialFiles={importFiles}
          initialCats={cats}
          hasApiKey={!!settings.apiKey}
          onBusyChange={setImportBusy}
          onClose={() => setImportFiles(null)}
          onFinished={(outcomes) => void importDone(outcomes)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          papers={papers}
          onClose={() => setPaletteOpen(false)}
          onOpenPaper={openPaperFromTree}
          commands={[
            { id: 'add', label: '导入 PDF 文献…', hint: '文件', run: addPapers },
            { id: 'picklib', label: '选择文献库文件夹…', hint: '文件', run: () => void pickLibraryNow() },
            { id: 'reindex', label: '重建全库索引', hint: '文件', run: () => void window.api.rebuildIndex() },
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
