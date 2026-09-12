import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('settings:save', patch),
  pickLibrary: () => ipcRenderer.invoke('library:pick'),
  scanLibrary: (libPath?: string) => ipcRenderer.invoke('library:scan', libPath),
  listPapers: () => ipcRenderer.invoke('papers:list'),
  setStatus: (id: number, status: string) => ipcRenderer.invoke('papers:status', id, status),
  readPdf: (p: string) => ipcRenderer.invoke('pdf:read', p),
  indexStatus: () => ipcRenderer.invoke('index:status'),
  rebuildIndex: () => ipcRenderer.invoke('index:rebuild'),
  startIndex: () => ipcRenderer.send('index:start'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  pickImport: () => ipcRenderer.invoke('papers:pick-import'),
  importPapers: (paths: string[]) => ipcRenderer.invoke('papers:import', paths),
  addHighlight: (paperId: number, page: number, rects: Array<{ x: number; y: number; w: number; h: number }>, text: string) =>
    ipcRenderer.invoke('highlights:add', paperId, page, rects, text),
  listHighlights: (paperId: number) => ipcRenderer.invoke('highlights:list', paperId),
  deleteHighlight: (id: number) => ipcRenderer.invoke('highlights:delete', id),
  paperMenu: (id: number, x: number, y: number) => ipcRenderer.send('papers:menu', id, x, y),
  categoryMenu: (cat: string, x: number, y: number) => ipcRenderer.send('category:menu', cat, x, y),
  renameCategory: (from: string, to: string) => ipcRenderer.invoke('category:rename', from, to),
  onCategoryRenameRequest: (cb: (cat: string) => void) => {
    const h = (_e: unknown, cat: string) => cb(cat)
    ipcRenderer.on('category:rename-request', h)
    return () => ipcRenderer.removeListener('category:rename-request', h)
  },
  reclassifyAll: () => ipcRenderer.send('papers:reclassify-all'),
  reclassifyOne: (id: number) => ipcRenderer.invoke('papers:reclassify-one', id),
  testLLM: () => ipcRenderer.invoke('llm:test'),
  testEmbed: () => ipcRenderer.invoke('embed:test'),
  onClassifyProgress: (cb: (p: unknown) => void) => {
    const h = (_e: unknown, p: unknown) => cb(p)
    ipcRenderer.on('classify:progress', h)
    return () => ipcRenderer.removeListener('classify:progress', h)
  },

  // 流式对话：返回 stop 不需要（请求即发即忘，以 reqId 收尾）
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
  syncTheme: (theme: string) => ipcRenderer.send('ui:theme', theme)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
