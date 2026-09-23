import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('settings:save', patch),
  pickLibrary: () => ipcRenderer.invoke('library:pick'),
  scanLibrary: (libPath?: string) => ipcRenderer.invoke('library:scan', libPath),
  listPapers: () => ipcRenderer.invoke('papers:list'),
  listCategories: () => ipcRenderer.invoke('categories:list'),
  setStatus: (id: number, status: string) => ipcRenderer.invoke('papers:status', id, status),
  readPdf: (p: string) => ipcRenderer.invoke('pdf:read', p),
  indexStatus: () => ipcRenderer.invoke('index:status'),
  rebuildIndex: () => ipcRenderer.invoke('index:rebuild'),
  startIndex: () => ipcRenderer.send('index:start'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  pickImport: () => ipcRenderer.invoke('papers:pick-import'),
  importPapers: (items: Array<{ path: string; category?: string }>) => ipcRenderer.invoke('papers:import', items),
  previewImport: (paths: string[]) => ipcRenderer.invoke('papers:preview-import', paths),
  onPreviewFile: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p)
    ipcRenderer.on('preview:file', h)
    return () => ipcRenderer.removeListener('preview:file', h)
  },
  onPreviewProgress: (cb: (p: { done: number; total: number; current: string }) => void) => {
    const h = (_e: unknown, p: { done: number; total: number; current: string }) => cb(p)
    ipcRenderer.on('preview:progress', h)
    return () => ipcRenderer.removeListener('preview:progress', h)
  },
  addHighlight: (paperId: number, page: number, rects: Array<{ x: number; y: number; w: number; h: number }>, text: string) =>
    ipcRenderer.invoke('highlights:add', paperId, page, rects, text),
  listHighlights: (paperId: number) => ipcRenderer.invoke('highlights:list', paperId),
  deleteHighlight: (id: number) => ipcRenderer.invoke('highlights:delete', id),
  paperMenu: (id: number, x: number, y: number) => ipcRenderer.send('papers:menu', id, x, y),
  categoryMenu: (cat: string, x: number, y: number) => ipcRenderer.send('category:menu', cat, x, y),
  blankMenu: (x: number, y: number) => ipcRenderer.send('library:blank-menu', x, y),
  renameCategory: (from: string, to: string) => ipcRenderer.invoke('category:rename', from, to),
  categoryExport: (cat: string) => ipcRenderer.invoke('category:export', cat),
  renamePaper: (id: number, title: string) => ipcRenderer.invoke('papers:rename', id, title),
  movePaper: (id: number, category: string) => ipcRenderer.invoke('papers:move', id, category),
  createCategory: (name: string) => ipcRenderer.invoke('category:create', name),
  deleteCategory: (name: string) => ipcRenderer.invoke('category:delete', name),
  markOpened: (id: number) => ipcRenderer.send('papers:opened', id),
  pickImportFolder: () => ipcRenderer.invoke('papers:pick-import-folder'),
  onCategoryRenameRequest: (cb: (cat: string) => void) => {
    const h = (_e: unknown, cat: string) => cb(cat)
    ipcRenderer.on('category:rename-request', h)
    return () => ipcRenderer.removeListener('category:rename-request', h)
  },
  onPapersRenameRequest: (cb: (p: { id: number; title: string }) => void) => {
    const h = (_e: unknown, p: { id: number; title: string }) => cb(p)
    ipcRenderer.on('papers:rename-request', h)
    return () => ipcRenderer.removeListener('papers:rename-request', h)
  },
  onCategoryCreateRequest: (cb: () => void) => {
    const h = (): void => cb()
    ipcRenderer.on('category:create-request', h)
    return () => ipcRenderer.removeListener('category:create-request', h)
  },
  onMoveNewRequest: (cb: (p: { id: number; title: string }) => void) => {
    const h = (_e: unknown, p: { id: number; title: string }) => cb(p)
    ipcRenderer.on('papers:move-new-request', h)
    return () => ipcRenderer.removeListener('papers:move-new-request', h)
  },
  onPapersChanged: (cb: () => void) => {
    const h = (): void => cb()
    ipcRenderer.on('papers:changed', h)
    return () => ipcRenderer.removeListener('papers:changed', h)
  },
  onImportRequest: (cb: () => void) => {
    const h = (): void => cb()
    ipcRenderer.on('app:import-request', h)
    return () => ipcRenderer.removeListener('app:import-request', h)
  },
  onImportFile: (cb: (o: unknown) => void) => {
    const h = (_e: unknown, o: unknown) => cb(o)
    ipcRenderer.on('import:file', h)
    return () => ipcRenderer.removeListener('import:file', h)
  },
  testLLM: (over?: { apiBase?: string; apiKey?: string; model?: string; provider?: string }) => ipcRenderer.invoke('llm:test', over),
  testEmbed: () => ipcRenderer.invoke('embed:test'),

  // 流式对话：返回 stop 中断句柄（主进程 abort 后照常走 onEnd 收尾）
  stream: (args: Record<string, unknown>, handlers: { onDelta: (t: string) => void; onEnd: () => void; onSources?: (s: unknown[]) => void }) => {
    const reqId = Date.now() + Math.floor(Math.random() * 1e6)
    const deltaCh = `llm:delta:${reqId}`
    const endCh = `llm:end:${reqId}`
    const srcCh = `llm:sources:${reqId}`
    const onDelta = (_e: unknown, t: string) => handlers.onDelta(t)
    const onEnd = () => {
      cleanup()
      handlers.onEnd()
    }
    const onSources = (_e: unknown, s: unknown[]) => handlers.onSources?.(s)
    function cleanup(): void {
      ipcRenderer.removeListener(deltaCh, onDelta)
      ipcRenderer.removeListener(endCh, onEnd)
      ipcRenderer.removeListener(srcCh, onSources)
    }
    ipcRenderer.on(deltaCh, onDelta)
    ipcRenderer.on(endCh, onEnd)
    ipcRenderer.on(srcCh, onSources)
    ipcRenderer.send('llm:stream', { reqId, ...args })
    return () => ipcRenderer.send('llm:stop', reqId)
  },

  onIndexProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p)
    ipcRenderer.on('index:progress', h)
    return () => ipcRenderer.removeListener('index:progress', h)
  },
  onImportProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p)
    ipcRenderer.on('import:progress', h)
    return () => ipcRenderer.removeListener('import:progress', h)
  },
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  syncTheme: (theme: string) => ipcRenderer.send('ui:theme', theme),

  // 对话历史（全库对话按会话持久化）
  chatsList: () => ipcRenderer.invoke('chats:list'),
  chatLoad: (id: number) => ipcRenderer.invoke('chat:load', id),
  chatCreate: (title: string) => ipcRenderer.invoke('chat:create', title),
  chatAppend: (id: number, role: string, content: string, sources?: string) =>
    ipcRenderer.invoke('chat:append', id, role, content, sources),
  chatRename: (id: number, title: string) => ipcRenderer.invoke('chat:rename', id, title),
  chatDelete: (id: number) => ipcRenderer.invoke('chat:delete', id),
  chatSetMessages: (id: number, msgs: Array<{ role: string; content: string; sources?: unknown }>) =>
    ipcRenderer.invoke('chat:set-messages', id, msgs),

  // 本地字体列表（设置里选全局字体用）
  listFonts: () => ipcRenderer.invoke('fonts:list'),

  // 版本与更新
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
