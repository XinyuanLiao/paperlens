export interface Paper {
  id: number
  slug: string
  title: string
  authors: string
  year: number | null
  venue: string
  category: string
  path: string
  status: string
  n_pages: number
  indexed: number
  added_at: string
  opened_at?: string | null
}

// 多服务商配置（设置页可维护多套，对话界面切换模型时自动激活所属配置）
export interface ProviderProfile {
  provider: string
  apiBase: string
  apiKey: string
  models: string[]
}

export interface Settings {
  libraryPath: string
  apiBase: string
  apiKey: string
  model: string
  models?: string[]
  // 思考开关二态（旧版 default/low/medium/high 读取时自动迁移为 on）
  thinkingLevel?: 'off' | 'on'
  provider: string
  translateTarget: string
  theme: 'system' | 'light' | 'dark'
  // 全局界面字体（空 = 跟随默认栈）
  fontFamily?: string
  setupDone?: boolean
  profiles?: ProviderProfile[]
  // ---- RAG 管线 ----
  // 嵌入固定为本地 BAAI/bge-m3（自动下载），无需配置
  pdfEngine?: 'builtin' | 'marker'
  markerCmd?: string
  rerankProvider?: 'off' | 'local'
  queryRewrite?: boolean
  answerVerify?: boolean
}

export interface HighlightRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Highlight {
  id: number
  page: number
  rects: HighlightRect[]
  text: string
}

export interface ImportOutcome {
  file: string
  // 源文件完整路径（弹窗按它精确匹配队列行）
  path?: string
  ok: boolean
  slug?: string
  title?: string
  category?: string
  classified: boolean
  error?: string
}

// 导入预检（逐篇 AI 识别，不落盘）：弹窗队列每行的推荐分类来源
export interface ImportPreviewItem {
  file: string
  path: string
  ok: boolean
  category?: string
  title?: string
  error?: string
}

export interface SourceRef {
  n: number
  slug: string
  title: string
  page: number
  // 命中块原文（截断），引用跳转用它定位到页内真实段落
  snippet?: string
  // 章节信息（marker 引擎，v4 分块）：来源标注与跳转提示用
  sectionNo?: string
  sectionTitle?: string
}

// 回答后校验：引用/事实/逻辑三级
export interface VerifyIssue {
  type: 'citation' | 'fact' | 'logic'
  severity: 'warn' | 'error'
  detail: string
  refs?: number[]
}

export interface VerifyReport {
  level: 'pass' | 'warn' | 'error' | 'skipped'
  // 规则层结果（始终运行）：引用编号存在性等
  ruleCitations: { ok: boolean; missing: number[]; unused: number[] }
  issues: VerifyIssue[]
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  sources?: SourceRef[]
  verify?: VerifyReport
}

// 对话历史条目（侧栏对话模式下的历史列表）
export interface ChatMeta {
  id: number
  title: string
  updated_at: string
  n: number
}

declare global {
  interface Window {
    api: {
      getSettings: () => Promise<Settings>
      saveSettings: (patch: Partial<Settings>) => Promise<Settings>
      pickLibrary: () => Promise<string | null>
      scanLibrary: (libPath?: string) => Promise<{ added: number; updated: number; total: number; indexing: boolean }>
      listPapers: () => Promise<Paper[]>
      listCategories: () => Promise<string[]>
      setStatus: (id: number, status: string) => Promise<void>
      readPdf: (p: string) => Promise<ArrayBuffer>
      indexStatus: () => Promise<{ papers: number; indexed: number; chunks: number; running: boolean }>
      rebuildIndex: () => Promise<boolean>
      startIndex: () => void
      pathForFile: (file: File) => string
      pickImport: () => Promise<string[]>
      importPapers: (items: Array<{ path: string; category?: string }>) => Promise<{ outcomes: ImportOutcome[]; scan: { added: number; updated: number; total: number } }>
      previewImport: (paths: string[]) => Promise<ImportPreviewItem[]>
      onPreviewFile: (cb: (p: ImportPreviewItem) => void) => () => void
      onPreviewProgress: (cb: (p: { done: number; total: number; current: string }) => void) => () => void
      addHighlight: (paperId: number, page: number, rects: HighlightRect[], text: string) => Promise<number>
      listHighlights: (paperId: number) => Promise<Highlight[]>
      deleteHighlight: (id: number) => Promise<boolean>
      paperMenu: (id: number, x: number, y: number) => void
      categoryMenu: (cat: string, x: number, y: number) => void
      blankMenu: (x: number, y: number) => void
      renameCategory: (from: string, to: string) => Promise<{ renamed: string; scan: { added: number; updated: number; total: number } }>
      categoryExport: (cat: string) => Promise<void>
      renamePaper: (id: number, title: string) => Promise<{ title: string }>
      movePaper: (id: number, category: string) => Promise<{ ok: boolean; category?: string; path?: string; moved?: boolean }>
      createCategory: (name: string) => Promise<{ name: string; dir: string }>
      deleteCategory: (name: string) => Promise<boolean>
      markOpened: (id: number) => void
      pickImportFolder: () => Promise<string | null>
      onCategoryRenameRequest: (cb: (cat: string) => void) => () => void
      onPapersRenameRequest: (cb: (p: { id: number; title: string }) => void) => () => void
      onCategoryCreateRequest: (cb: () => void) => () => void
      onMoveNewRequest: (cb: (p: { id: number; title: string }) => void) => () => void
      onPapersChanged: (cb: () => void) => () => void
      onImportRequest: (cb: () => void) => () => void
      onImportFile: (cb: (o: ImportOutcome) => void) => () => void
      testLLM: (over?: { apiBase?: string; apiKey?: string; model?: string; provider?: string }) => Promise<{ ok: boolean; model?: string; latencyMs?: number; balance?: { amount: string; currency: string } | null; quota?: string; error?: string }>
      testEmbed: () => Promise<{ ok: boolean; dim?: number; error?: string }>
      testMarker: () => Promise<{ ok: boolean; version?: string; error?: string }>
      testRerank: () => Promise<{ ok: boolean; device?: string; scores?: number[]; error?: string }>
      stream: (
        args: Record<string, unknown>,
        handlers: { onDelta: (t: string) => void; onEnd: () => void; onSources?: (s: SourceRef[]) => void; onVerify?: (v: VerifyReport) => void }
      ) => () => void
      onIndexProgress: (cb: (p: { done: number; total: number; phase: string; current?: string }) => void) => () => void
      onImportProgress: (cb: (p: { done: number; total: number; current: string }) => void) => () => void
      openExternal: (url: string) => void
      syncTheme: (theme: string) => void
      chatsList: () => Promise<ChatMeta[]>
      chatLoad: (id: number) => Promise<ChatMsg[]>
      chatCreate: (title: string) => Promise<number>
      chatAppend: (id: number, role: string, content: string, sources?: string, verify?: string) => Promise<number>
      chatRename: (id: number, title: string) => Promise<boolean>
      chatDelete: (id: number) => Promise<boolean>
      chatExport: (id: number, title: string) => Promise<boolean>
      chatSetMessages: (id: number, msgs: Array<{ role: string; content: string; sources?: SourceRef[]; verify?: VerifyReport }>) => Promise<boolean>
      listFonts: () => Promise<string[]>
      appVersion: () => Promise<string>
      checkUpdate: () => Promise<
        | { ok: true; current: string; latest: string; url: string; notes: string; published: string }
        | { ok: false; current: string; error: string }
      >
    }
  }
}

export {}
