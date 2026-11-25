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
  // 翻译引擎：llm = 当前默认模型（需 API Key）；google/bing = 免费服务（详见 main/freetranslate.ts）
  translateEngine?: 'llm' | 'google' | 'bing'
  theme: 'system' | 'light' | 'dark'
  // 全局界面字体（空 = 跟随默认栈）
  fontFamily?: string
  setupDone?: boolean
  profiles?: ProviderProfile[]
  // ---- RAG 管线 ----
  // 嵌入由 Ollama 管理（模型名在 Ollama 侧 pull）；PDF 结构化解析（liteparse）内置，无设置项
  ollamaUrl?: string
  ollamaEmbedModel?: string
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

// 批注颜色（白名单，主进程 src/main/notes.ts 同一份）
export type HlColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

// 批注 = 高亮 + 颜色 + 批注文字
export interface Highlight {
  id: number
  page: number
  rects: HighlightRect[]
  text: string
  color: HlColor
  note: string
  created_at: string
}

// 自由笔记：page 为空 = 整篇笔记（每篇一条），否则是页面笔记
export interface Note {
  id: number
  paper_id: number
  page: number | null
  content: string
  updated_at: string
}

export interface AnnotationCount {
  hl: number
  notes: number
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
  // 命中块原文开头（供引用跳转定位到页内真实段落）
  snippet?: string
  // 章节信息（marker 引擎，v4 分块）：来源标注与跳转提示用
  sectionNo?: string
  sectionTitle?: string
  // 论文级元数据（片段模式下来源按论文去重后随发）：引用悬停卡与来源面板用
  venue?: string
  authors?: string
  year?: number | null
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

// 参考文献元数据（主进程 CrossRef/Unpaywall/S2 聚合，见 src/main/refmeta.ts）
export interface RefMeta {
  title: string
  authors: string
  year: number | null
  venue: string
  doi: string
  citedBy: number | null
  pdfUrls: string[]
  landing: string
  source: 'crossref' | 's2' | 'none'
  // CrossRef 条目类型（BibTeX 导出区分期刊/会议用）
  kind?: string
}

// 批量 BibTeX 导出：单条核对结果（见 src/main/bibexport.ts）
// source 三档置信度：official=DOI 官方条目（双重比对通过）/ web=检索元数据拼装 / local=库内拼装
export interface BibExportEntry {
  slug: string
  title: string
  key: string
  bibtex: string
  source: 'official' | 'web' | 'local'
  warnings: string[]
}

export interface BibExportResult {
  entries: BibExportEntry[]
  official: number
  web: number
  local: number
}

// 浏览器扩展导入（见 src/shared/connector.ts）
export interface ConnectorActivity {
  at: number
  // ping = 扩展在探测服务；save = 一次保存请求
  kind: 'ping' | 'save'
  title?: string
  // saved = 新入库；duplicate = 已在文库；no-pdf = 没取到全文；error = 失败
  status?: 'saved' | 'duplicate' | 'no-pdf' | 'error'
  message?: string
  // pdf = 浏览器把 PDF 一起传来了；metadata = 只传来元数据、全文由应用自己取
  via?: 'pdf' | 'metadata'
}

export interface ConnectorInfo extends ConnectorStatus {
  recent: ConnectorActivity[]
  // 扩展弹窗里的默认分类：'' = 未分类；'__auto__' = AI 归类；其余为分类名
  defaultCategory: string
}

export interface ConnectorStatus {
  running: boolean
  port: number | null
  // 启动失败的原因（如端口全部被占用）
  error?: string
  // 扩展目录（用户把它加载进浏览器）
  dir: string
  // 目录确实存在（打包或源码里带了扩展）
  dirExists: boolean
  // 扩展是否连过（自启动以来收到过请求）
  seen: boolean
  lastSeenAt: number | null
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
      addHighlight: (paperId: number, page: number, rects: HighlightRect[], text: string, color?: HlColor) => Promise<number>
      listHighlights: (paperId: number) => Promise<Highlight[]>
      updateHighlight: (id: number, patch: { note?: string; color?: HlColor }) => Promise<boolean>
      deleteHighlight: (id: number) => Promise<boolean>
      // 自由笔记（整篇 / 按页）；存成空白等于删除，返回笔记 id（删除时为 0）
      listNotes: (paperId: number) => Promise<Note[]>
      saveNote: (input: { id?: number; paperId: number; page?: number | null; content: string }) => Promise<number>
      deleteNote: (id: number) => Promise<boolean>
      // 各论文的批注 / 笔记条数（文献列表角标），只含有内容的论文
      annotationCounts: () => Promise<Record<number, AnnotationCount>>
      exportNotes: (paperId: number) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
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
      // 向服务商拉取可用模型列表（设置页「同步模型」）
      listModels: (over?: { apiBase?: string; apiKey?: string; provider?: string }) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>
      testEmbed: () => Promise<{ ok: boolean; dim?: number; error?: string }>
      testRerank: () => Promise<{ ok: boolean; device?: string; scores?: number[]; error?: string }>
      enrichRun: () => Promise<boolean>
      onEnrichProgress: (cb: (p: { phase: string; done: number; total: number; fixed: number }) => void) => () => void
      bibExportRun: (force?: boolean) => Promise<boolean>
      bibExportCancel: () => Promise<boolean>
      bibExportSave: (slugs: string[]) => Promise<{ ok: boolean; path?: string; n?: number; canceled?: boolean; error?: string }>
      onBibProgress: (cb: (p: { phase: string; done: number; total: number; cancelled?: boolean }) => void) => () => void
      onBibResult: (cb: (r: BibExportResult) => void) => () => void
      stream: (
        args: Record<string, unknown>,
        handlers: {
          onDelta: (t: string) => void
          onEnd: () => void
          onSources?: (s: SourceRef[]) => void
          onVerify?: (v: VerifyReport) => void
          // 推理片段（思考模型先于正文输出的推理过程）
          onReason?: (t: string) => void
        }
      ) => () => void
      onIndexProgress: (cb: (p: { done: number; total: number; phase: string; current?: string }) => void) => () => void
      onImportProgress: (cb: (p: { done: number; total: number; current: string }) => void) => () => void
      openExternal: (url: string) => void
      syncTheme: (theme: string) => void
      // 浏览器扩展导入
      connectorStatus: () => Promise<ConnectorInfo | null>
      connectorRestart: () => Promise<ConnectorInfo | null>
      // 打开扩展目录：返回空串表示成功，否则是错误信息
      connectorOpenDir: () => Promise<string>
      // 扩展弹窗里的默认分类（'' = 未分类，'__auto__' = AI 归类）
      setConnectorCategory: (cat: string) => Promise<void>
      onConnectorActivity: (cb: (a: ConnectorActivity) => void) => () => void
      // 扩展导入完成后，主进程通知在这里打开新论文
      onOpenPaperRequest: (cb: (p: { slug: string }) => void) => () => void
      lookupRef: (raw: string) => Promise<RefMeta | null>
      importRefPdf: (args: { urls: string[]; category: string; title: string; authors?: string; year?: number | null; venue?: string }) => Promise<{ ok: boolean; slug?: string; title?: string; error?: string }>
      citedBy: (slug: string, title: string) => Promise<number | null>
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
