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
  thinkingLevel?: 'default' | 'off' | 'low' | 'medium' | 'high'
  provider: string
  embedProvider: 'local' | 'zhipu' | 'ollama'
  ollamaUrl: string
  ollamaEmbedModel: string
  translateTarget: string
  theme: 'system' | 'light' | 'dark'
  setupDone?: boolean
  profiles?: ProviderProfile[]
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
  ok: boolean
  slug?: string
  title?: string
  category?: string
  classified: boolean
  error?: string
}

export interface SourceRef {
  n: number
  slug: string
  title: string
  page: number
  // 命中块原文（截断），引用跳转用它定位到页内真实段落
  snippet?: string
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  sources?: SourceRef[]
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
      importPapers: (paths: string[], category?: string) => Promise<{ outcomes: ImportOutcome[]; scan: { added: number; updated: number; total: number } }>
      addHighlight: (paperId: number, page: number, rects: HighlightRect[], text: string) => Promise<number>
      listHighlights: (paperId: number) => Promise<Highlight[]>
      deleteHighlight: (id: number) => Promise<boolean>
      paperMenu: (id: number, x: number, y: number) => void
      categoryMenu: (cat: string, x: number, y: number) => void
      blankMenu: (x: number, y: number) => void
      renameCategory: (from: string, to: string) => Promise<{ renamed: string; scan: { added: number; updated: number; total: number } }>
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
      testLLM: () => Promise<{ ok: boolean; model?: string; latencyMs?: number; balance?: { amount: string; currency: string } | null; quota?: string; error?: string }>
      testEmbed: () => Promise<{ ok: boolean; dim?: number; error?: string }>
      stream: (
        args: Record<string, unknown>,
        handlers: { onDelta: (t: string) => void; onEnd: () => void; onSources?: (s: SourceRef[]) => void }
      ) => void
      onIndexProgress: (cb: (p: { done: number; total: number; phase: string; current?: string }) => void) => () => void
      onImportProgress: (cb: (p: { done: number; total: number; current: string }) => void) => () => void
      openExternal: (url: string) => void
      syncTheme: (theme: string) => void
    }
  }
}

export {}
