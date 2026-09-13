import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import * as dbmod from './db'
import { buildIndex, isIndexRunning, indexNeedsRebuild, hybridSearch, extractPagesCached } from './ingest'
import { chatStream, translateMessages, explainMessages, ragMessages, paperFullMessages, testLLM, type ChatMessage } from './llm'
import { importPapers, reclassifyAll, reclassifyOne } from './import'
import { embed } from './embed'

let win: BrowserWindow | null = null

function send(ev: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(ev, payload)
}

// Windows/Linux 上窗口控制按钮由系统绘制在自绘顶栏右上角（titleBarOverlay），
// 颜色随应用主题同步；macOS 用隐藏标题栏 + 红绿灯。
function overlayColors(theme: string): { color: string; symbolColor: string } {
  const dark = theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors)
  return dark ? { color: '#211d1e', symbolColor: '#ece7e9' } : { color: '#f6f4f2', symbolColor: '#241f21' }
}

function createWindow(): void {
  const { screen } = require('electron') as typeof import('electron')
  const wa = screen.getPrimaryDisplay().workArea
  const w = Math.min(1560, wa.width - 16)
  const h = Math.min(960, wa.height - 8)
  win = new BrowserWindow({
    width: w,
    height: h,
    x: wa.x + Math.max(0, Math.floor((wa.width - w) / 2)),
    y: wa.y + Math.max(0, Math.floor((wa.height - h) / 2)),
    minWidth: 1080,
    minHeight: 640,
    backgroundColor: '#16171a',
    title: 'PaperLens',
    titleBarStyle: process.platform === 'linux' ? 'default' : 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { ...overlayColors('system'), height: 40 } }
      : process.platform === 'darwin'
        ? { trafficLightPosition: { x: 14, y: 13 } }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.setName('PaperLens')

// 数据目录固定为小写 paperlens：开发与打包版本共用同一份数据库/设置（可用环境变量覆盖）
if (process.env.PAPERLENS_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.PAPERLENS_DATA_DIR))
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'paperlens'))
}

app.whenReady().then(() => {
  dbmod.initDb()
  registerIpc()
  createWindow()
  // macOS：Dock 图标与名字（打包后由 app bundle 提供，开发态手动设）
  if (process.platform === 'darwin') {
    try {
      const iconPng = path.join(app.getAppPath(), 'build/icon.png')
      const img = fs.existsSync(iconPng) ? nativeImage.createFromPath(iconPng) : null
      if (img && !img.isEmpty()) app.dock?.setIcon(img)
    } catch {
      /* Dock 图标设置失败不影响使用 */
    }
  }
  const s = dbmod.getSettings()
  if (s.libraryPath && fs.existsSync(s.libraryPath)) {
    try {
      const r = dbmod.scanLibrary(s.libraryPath)
      console.log(`[scan] 新增 ${r.added} 更新 ${r.updated} 共 ${r.total}`)
      if (indexNeedsRebuild() && !isIndexRunning()) void buildIndex(send).catch((e) => console.error('[index]', e))
    } catch (e) {
      console.error('[scan]', e)
    }
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc(): void {
  ipcMain.handle('settings:get', () => dbmod.getSettings())
  ipcMain.handle('settings:save', (_e, patch) => dbmod.saveSettings(patch))

  ipcMain.handle('library:pick', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], message: '选择工作区文件夹（论文存储结构由应用自动管理）' })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('library:scan', (_e, libPath?: string) => {
    const p = libPath ?? dbmod.getSettings().libraryPath
    const r = dbmod.scanLibrary(p)
    if (libPath) dbmod.saveSettings({ libraryPath: libPath })
    const pending = indexNeedsRebuild()
    if (pending && !isIndexRunning()) void buildIndex(send).catch((e) => console.error('[index]', e))
    return { ...r, indexing: pending }
  })

  ipcMain.handle('papers:list', () => dbmod.listPapers())
  ipcMain.handle('papers:status', (_e, id: number, status: string) => dbmod.setStatus(id, status))

  // 添加文献（AI 自动归类）
  ipcMain.handle('papers:pick-import', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择要导入的 PDF 论文',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('papers:import', async (_e, paths: string[]) => {
    const outcomes = await importPapers(paths, send)
    const r = dbmod.scanLibrary(dbmod.getSettings().libraryPath)
    if (indexNeedsRebuild() && !isIndexRunning()) void buildIndex(send).catch(() => {})
    return { outcomes, scan: r }
  })

  // AI 重新归类
  ipcMain.on('papers:reclassify-all', () => {
    if (!dbmod.getSettings().apiKey) {
      send('classify:progress', { done: 0, total: 0, current: '', error: '未配置 API Key，无法 AI 归类' })
      return
    }
    void reclassifyAll(send).catch((e) => send('classify:progress', { done: 0, total: 0, current: '', error: String(e) }))
  })
  ipcMain.handle('papers:reclassify-one', async (_e, id: number) => {
    if (!dbmod.getSettings().apiKey) return false
    return reclassifyOne(id, send)
  })

  // 右键菜单：导出 / 分享 / 归类
  ipcMain.on('papers:menu', (_e, id: number, x: number, y: number) => {
    const p = dbmod.getDb().prepare('SELECT id, slug, title, year, path FROM papers WHERE id=?').get(id) as
      | { id: number; slug: string; title: string; year: number | null; path: string }
      | undefined
    if (!p || !win) return
    const menu = Menu.buildFromTemplate([
      {
        label: '导出 PDF…',
        click: () => {
          void dialog
            .showSaveDialog(win!, { defaultPath: `${p.title.slice(0, 60) || p.slug}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
            .then((r) => {
              if (r.canceled || !r.filePath) return
              try {
                fs.copyFileSync(p.path, r.filePath)
              } catch (err) {
                dialog.showMessageBox(win!, { message: `导出失败：${String(err)}` })
              }
            })
        }
      },
      { label: process.platform === 'win32' ? '在文件资源管理器中显示' : '在访达中显示', click: () => shell.showItemInFolder(p.path) },
      { label: '复制标题', click: () => clipboard.writeText(p.title) },
      {
        label: '复制引用',
        click: () => clipboard.writeText(`${p.title} (${p.year ?? 'n.d.'})`)
      },
      { type: 'separator' },
      {
        label: 'AI 重新归类这篇',
        click: () => {
          if (!dbmod.getSettings().apiKey) {
            dialog.showMessageBox(win!, { message: '未配置 API Key，无法 AI 归类' })
            return
          }
          void reclassifyOne(id, send)
        }
      }
    ])
    menu.popup({ window: win, x: Math.round(x), y: Math.round(y) })
  })

  // 划词高亮持久化
  ipcMain.handle(
    'highlights:add',
    (_e, paperId: number, page: number, rects: Array<{ x: number; y: number; w: number; h: number }>, text: string) => {
      const r = dbmod
        .getDb()
        .prepare('INSERT INTO highlights(paper_id,page,rects,text) VALUES(?,?,?,?)')
        .run(paperId, page, JSON.stringify(rects), text.slice(0, 500))
      return Number(r.lastInsertRowid)
    }
  )
  ipcMain.handle('highlights:list', (_e, paperId: number) =>
    (dbmod.getDb().prepare('SELECT id, page, rects, text FROM highlights WHERE paper_id=?').all(paperId) as Array<{
      id: number
      page: number
      rects: string
      text: string
    }>).map((h) => ({ ...h, rects: JSON.parse(h.rects) }))
  )
  ipcMain.handle('highlights:delete', (_e, hid: number) => {
    dbmod.getDb().prepare('DELETE FROM highlights WHERE id=?').run(hid)
    return true
  })

  ipcMain.handle('pdf:read', (_e, pdfPath: string) => {
    const libSetting = dbmod.getSettings().libraryPath
    if (!libSetting) throw new Error('文献库未设置，请先在设置中选择工作区文件夹')
    const lib = path.resolve(libSetting)
    const abs = path.resolve(pdfPath)
    // Windows 路径大小写不敏感，统一小写后做前缀比较；分隔符由 resolve 归一化
    const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (!norm(abs).startsWith(norm(lib) + path.sep) && norm(abs) !== norm(lib)) {
      throw new Error(`文件不在文献库内：${abs}`)
    }
    // 不预检 existsSync：iCloud/网盘占位文件在读取时会按需下载，预检反而拦掉
    try {
      return fs.readFileSync(abs)
    } catch {
      throw new Error(
        `无法读取（文件未同步到本机或已移动）：${abs}\n若是 iCloud / 网盘文献，请在文件管理器中右键对应文件夹选择「始终保留在此设备上」，同步完成后再试。`
      )
    }
  })

  // 渲染端主题变化时同步 Windows 标题栏 overlay 颜色
  ipcMain.on('ui:theme', (_e, theme: string) => {
    if (process.platform === 'win32' && win && !win.isDestroyed()) {
      try {
        win.setTitleBarOverlay(overlayColors(theme))
      } catch {
        /* 旧系统不支持 */
      }
    }
  })

  // 分类右键菜单：重命名 / 批量导出
  ipcMain.on('category:menu', (_e, cat: string, x: number, y: number) => {
    if (!win) return
    const menu = Menu.buildFromTemplate([
      {
        label: '重命名…',
        click: () => win!.webContents.send('category:rename-request', cat)
      },
      {
        label: '导出该分类…',
        click: () => void exportCategory(cat)
      }
    ])
    menu.popup({ window: win, x: Math.round(x), y: Math.round(y) })
  })

  ipcMain.handle('category:rename', (_e, from: string, to: string) => {
    const toSlug = String(to)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!toSlug) throw new Error('名称无效（仅限小写字母/数字/连字符）')
    const db = dbmod.getDb()
    const rows = db.prepare('SELECT id, path FROM papers WHERE category=?').all(from) as Array<{ id: number; path: string }>
    const libPapers = path.join(dbmod.getSettings().libraryPath, 'papers')
    const dirs = [...new Set(rows.map((r) => path.dirname(path.dirname(r.path))))]
    for (const dir of dirs) {
      const target = path.join(path.dirname(dir), `${dir.split(/[/\\]/).pop()!.match(/^(\d+-)/)?.[1] ?? ''}${toSlug}`)
      if (!fs.existsSync(target)) fs.renameSync(dir, target)
    }
    const r = dbmod.scanLibrary(dbmod.getSettings().libraryPath)
    return { renamed: toSlug, scan: r }
  })

  async function exportCategory(cat: string): Promise<void> {
    const db = dbmod.getDb()
    const rows = db.prepare('SELECT path, slug FROM papers WHERE category=?').all(cat) as Array<{ path: string; slug: string }>
    if (!win) return
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: `选择导出「${cat}」的目标文件夹` })
    if (r.canceled || !r.filePaths[0]) return
    const destRoot = r.filePaths[0]
    let copied = 0
    for (const row of rows) {
      const srcDir = path.dirname(row.path)
      const destDir = path.join(destRoot, row.slug)
      try {
        fs.mkdirSync(destDir, { recursive: true })
        for (const f of fs.readdirSync(srcDir)) fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f))
        copied++
      } catch (err) {
        console.error('[export]', row.slug, err)
      }
    }
    dialog.showMessageBox(win, { message: `已导出 ${copied}/${rows.length} 篇到 ${destRoot}` })
  }

  ipcMain.handle('index:status', () => {
    const total = dbmod.getDb().prepare('SELECT COUNT(*) AS n FROM papers').get() as { n: number }
    const done = dbmod.getDb().prepare('SELECT COUNT(*) AS n FROM papers WHERE indexed=1').get() as { n: number }
    const nChunks = dbmod.getDb().prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
    return { papers: total.n, indexed: done.n, chunks: nChunks.n, running: isIndexRunning() }
  })
  ipcMain.handle('index:rebuild', async () => {
    dbmod.getDb().exec('DELETE FROM chunks; DELETE FROM chunks_fts; UPDATE papers SET indexed=0')
    if (!isIndexRunning()) void buildIndex(send).catch((e) => send('index:error', String(e)))
    return true
  })
  ipcMain.on('index:start', () => {
    if (!isIndexRunning()) void buildIndex(send).catch((e) => send('index:error', String(e)))
  })

  // 连接测试
  ipcMain.handle('llm:test', () => testLLM())
  ipcMain.handle('embed:test', async () => {
    try {
      const { dim } = await embed(['connection test'])
      return { ok: true, dim }
    } catch (err) {
      return { ok: false, error: String(err).slice(0, 300) }
    }
  })

  // LLM 流式：reqId 关联渲染端回调
  ipcMain.on(
    'llm:stream',
    async (
      _e,
      args: {
        reqId: number
        mode: 'chat' | 'translate' | 'explain' | 'rag'
        messages?: ChatMessage[]
        text?: string
        context?: string
        question?: string
        scopePaperId?: number
        category?: string
        paperTitle?: string
        history?: Array<{ role: 'user' | 'assistant'; content: string }>
      }
    ) => {
      try {
        let msgs: ChatMessage[]
        let sources: import('./ingest').RetrievedChunk[] = []
        if (args.mode === 'translate') msgs = translateMessages(args.text!, args.context ?? '', dbmod.getSettings().translateTarget)
        else if (args.mode === 'explain') msgs = explainMessages(args.text!, args.context ?? '')
        else if (args.mode === 'rag') {
          if (args.scopePaperId) {
            // 整篇模式：完整论文正文进提示词（按页标记，引用为 [页码]）
            const paper = dbmod
              .getDb()
              .prepare('SELECT id, slug, title, path FROM papers WHERE id=?')
              .get(args.scopePaperId) as { id: number; slug: string; title: string; path: string } | undefined
            if (!paper) throw new Error('论文不存在')
            let pages: string[] = []
            try {
              pages = await extractPagesCached(paper.path)
            } catch {
              pages = []
            }
            if (pages.length > 0) {
              sources = pages.map((t, i) => ({ paperId: paper.id, slug: paper.slug, title: paper.title, page: i + 1, text: t, score: 1, snippet: '' }))
              msgs = paperFullMessages(args.question!, pages, paper.title, undefined, args.history)
            } else {
              sources = await hybridSearch(args.question!, args.scopePaperId, 10, args.category)
              msgs = ragMessages(args.question!, sources.map((s, i) => ({ label: `${s.title} (p.${s.page})`, text: s.text })), paper.title, args.history)
            }
          } else {
            sources = await hybridSearch(args.question!, undefined, 16, args.category)
            if (sources.length === 0) {
              send(`llm:delta:${args.reqId}`, '⚠️ 检索不到相关片段（可能索引尚未建好），请先重建索引。')
              send(`llm:end:${args.reqId}`, null)
              return
            }
            msgs = ragMessages(
              args.question!,
              sources.map((s, i) => ({ label: `${s.title} (p.${s.page})`, text: s.text })),
              args.paperTitle,
              args.history
            )
          }
        } else msgs = args.messages ?? []

        for await (const delta of chatStream(msgs)) send(`llm:delta:${args.reqId}`, delta)
        if (args.mode === 'rag')
          send(
            `llm:sources:${args.reqId}`,
            sources.map((s, i) => ({ n: i + 1, slug: s.slug, title: s.title, page: s.page, snippet: s.snippet || undefined }))
          )
        send(`llm:end:${args.reqId}`, null)
      } catch (err) {
        send(`llm:delta:${args.reqId}`, `\n\n❌ ${String(err)}`)
        send(`llm:end:${args.reqId}`, null)
      }
    }
  )

  ipcMain.on('open-external', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
}
