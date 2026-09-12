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
}

export interface Settings {
  libraryPath: string
  apiBase: string
  apiKey: string
  model: string
  provider: string
  embedProvider: 'local' | 'zhipu' | 'ollama'
  ollamaUrl: string
  ollamaEmbedModel: string
  translateTarget: string
  theme: 'system' | 'light' | 'dark'
  setupDone?: boolean
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
  category?: string
  classified: boolean
  error?: string
}

export interface SourceRef {
  n: number
  slug: string
  title: string
  page: number
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
      setStatus: (id: number, status: string) => Promise<void>
      readPdf: (p: string) => Promise<ArrayBuffer>
      indexStatus: () => Promise<{ papers: number; indexed: number; chunks: number; running: boolean }>
      rebuildIndex: () => Promise<boolean>
      startIndex: () => void
      pathForFile: (file: File) => string
      pickImport: () => Promise<string[]>
      importPapers: (paths: string[]) => Promise<{ outcomes: ImportOutcome[]; scan: { added: number; updated: number; total: number } }>
      addHighlight: (paperId: number, page: number, rects: HighlightRect[], text: string) => Promise<number>
      listHighlights: (paperId: number) => Promise<Highlight[]>
      deleteHighlight: (id: number) => Promise<boolean>
      paperMenu: (id: number, x: number, y: number) => void
      reclassifyAll: () => void
      reclassifyOne: (id: number) => Promise<boolean>
      testLLM: () => Promise<{ ok: boolean; model?: string; latencyMs?: number; balance?: { amount: string; currency: string } | null; error?: string }>
      testEmbed: () => Promise<{ ok: boolean; dim?: number; error?: string }>
      onClassifyProgress: (cb: (p: { done: number; total: number; current: string; error?: string }) => void) => () => void
      stream: (
        args: Record<string, unknown>,
        handlers: { onDelta: (t: string) => void; onEnd: () => void; onSources?: (s: SourceRef[]) => void }
      ) => void
      onIndexProgress: (cb: (p: { done: number; total: number; phase: string; current?: string }) => void) => () => void
      onImportProgress: (cb: (p: { done: number; total: number; current: string }) => void) => () => void
      openExternal: (url: string) => void
    }
  }
}

declare module '*?url' {
  const src: string
  export default src
}

export {}
