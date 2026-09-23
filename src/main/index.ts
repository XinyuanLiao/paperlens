import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import * as dbmod from './db'
import { buildIndex, isIndexRunning, indexNeedsRebuild, hybridSearch, extractPagesCached } from './ingest'
import { chatStream, translateMessages, explainMessages, ragMessages, paperFullMessages, testLLM, type ChatMessage } from './llm'
import { importPapers, previewImport, movePaperToCategory, createCategory, deleteCategory, deletePaper, renamePaper } from './import'
import { embed } from './embed'
import { listLocalFonts } from './fonts'

let win: BrowserWindow | null = null

function send(ev: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(ev, payload)
}

// ---------- 工作区重扫描：iCloud/网盘可能随时从别的设备同步来新文献 ----------
// 启动 / dock 重新激活 / 窗口聚焦（节流）/ 定时，都会扫描一遍；有变化才通知界面刷新
let lastScanAt = 0
function rescanLibrary(reason: string): void {
  const s = dbmod.getSettings()
  if (!s.libraryPath || !fs.existsSync(s.libraryPath)) return
  lastScanAt = Date.now()
  try {
    const r = dbmod.scanLibrary(s.libraryPath)
    console.log(`[scan:${reason}] 新增 ${r.added} 更新 ${r.updated} 共 ${r.total}`)
    if (r.added > 0 || r.updated > 0) send('papers:changed', { ids: [] })
    if (indexNeedsRebuild() && !isIndexRunning()) void buildIndex(send).catch((e) => console.error('[index]', e))
  } catch (e) {
    console.error('[scan]', e)
  }
}
function maybeRescan(reason: string, minIntervalMs: number): void {
  if (Date.now() - lastScanAt < minIntervalMs) return
  rescanLibrary(reason)
}

// Windows/Linux 上窗口控制按钮由系统绘制在自绘顶栏右上角（titleBarOverlay），
// 颜色随应用主题同步；macOS 用隐藏标题栏 + 红绿灯。
function overlayColors(theme: string): { color: string; symbolColor: string } {
  const dark = theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors)
  return dark ? { color: '#1f1e1d', symbolColor: '#f5f3ec' } : { color: '#f2f0e9', symbolColor: '#26231e' }
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
    backgroundColor: '#1f1e1d',
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
  // 窗口聚焦时重扫（节流 60s）：软件常驻后台时，云盘同步落地的新文献回到窗口就能看到
  win.on('focus', () => maybeRescan('focus', 60_000))
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
  // 每次打开软件都重扫工作区：个人云（iCloud 等）多设备同步可能带来新文献
  rescanLibrary('startup')
  // 兜底定时扫描：应用长时间开着、窗口一直没重新聚焦的网盘同步场景
  setInterval(() => maybeRescan('timer', 4 * 60_000), 4 * 60_000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    // macOS dock 图标被点开（相当于重新打开软件）时重扫
    rescanLibrary('activate')
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
  ipcMain.handle('categories:list', () => dbmod.listCategoryNames())
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
  ipcMain.handle('papers:pick-import-folder', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择文件夹（导入其中所有 PDF）',
      properties: ['openDirectory']
    })
    return r.canceled ? null : r.filePaths[0]
  })
  // 导入预检：逐篇 AI 识别推荐分类/标题（不落盘），弹窗展示给用户确认调整
  ipcMain.handle('papers:preview-import', (_e, paths: string[]) => previewImport(paths, send))
  ipcMain.handle('papers:import', async (_e, items: Array<{ path: string; category?: string }>) => {
    const outcomes = await importPapers(items, send)
    const r = dbmod.scanLibrary(dbmod.getSettings().libraryPath)
    if (indexNeedsRebuild() && !isIndexRunning()) void buildIndex(send).catch(() => {})
    send('papers:changed', { ids: outcomes.filter((o) => o.ok).map((o) => o.slug) }) // 兜底同步界面（弹窗收尾之外的路径）
    return { outcomes, scan: r }
  })
  ipcMain.handle('papers:rename', (_e, id: number, title: string) => {
    const r = renamePaper(id, String(title))
    // pvec 被清空 → 触发增量补嵌（只重嵌这一篇的整篇向量）
    if (indexNeedsRebuild() && !isIndexRunning()) void buildIndex(send).catch(() => {})
    send('papers:changed', { ids: [id] })
    return r
  })

  // 手动归类：右键菜单 / 拖拽都走这里（移动文件夹 + 原地改写 DB，保留行身份）
  ipcMain.handle('papers:move', (_e, id: number, category: string) => {
    const libPapers = path.join(dbmod.getSettings().libraryPath, 'papers')
    const r = movePaperToCategory(id, String(category), libPapers)
    send('papers:changed', { ids: [id] })
    return r ? { ok: true, ...r } : { ok: false }
  })

  ipcMain.handle('category:create', (_e, name: string) => {
    const libPapers = path.join(dbmod.getSettings().libraryPath, 'papers')
    return createCategory(String(name), libPapers)
  })
  ipcMain.handle('category:delete', (_e, name: string) => {
    const libPapers = path.join(dbmod.getSettings().libraryPath, 'papers')
    return deleteCategory(String(name), libPapers)
  })

  // 最近打开时间（「最近」视图排序用）
  ipcMain.on('papers:opened', (_e, id: number) => dbmod.markOpened(id))

  // 右键菜单：导出 / 分享 / 移动归类
  ipcMain.on('papers:menu', (_e, id: number, x: number, y: number) => {
    const p = dbmod.getDb().prepare('SELECT id, slug, title, year, path, category FROM papers WHERE id=?').get(id) as
      | { id: number; slug: string; title: string; year: number | null; path: string; category: string }
      | undefined
    if (!p || !win) return
    const libPapers = path.join(dbmod.getSettings().libraryPath, 'papers')
    const cats = dbmod.listCategoryNames().filter((c) => c !== p.category)
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
        label: '重命名…',
        click: () => win!.webContents.send('papers:rename-request', { id, title: p.title })
      },
      {
        label: '移动到分类',
        submenu: [
          ...cats.map((c) => ({
            label: c,
            click: () => {
              try {
                movePaperToCategory(id, c, libPapers)
                send('papers:changed', { ids: [id] })
              } catch (err) {
                dialog.showMessageBox(win!, { message: `移动失败：${String(err)}` })
              }
            }
          })),
          ...(cats.length ? [{ type: 'separator' as const }] : []),
          {
            label: '新建分类并移入…',
            click: () => win!.webContents.send('papers:move-new-request', { id, title: p.title })
          }
        ]
      },
      {
        label: '删除文献…',
        click: () => {
          const ok = dialog.showMessageBoxSync(win!, {
            type: 'warning',
            title: '删除文献',
            message: `删除《${p.title.slice(0, 80) || p.slug}》？`,
            detail: '论文文件夹将移入系统废纸篓（可找回），阅读状态、高亮与索引一并清除。',
            buttons: ['移入废纸篓', '取消'],
            defaultId: 1,
            cancelId: 1,
            noLink: true
          })
          if (ok !== 0) return
          deletePaper(id)
            .then(() => send('papers:changed', { ids: [] }))
            .catch((err) => dialog.showMessageBox(win!, { message: `删除失败：${String(err)}` }))
        }
      }
    ])
    menu.popup({ window: win, x: Math.round(x), y: Math.round(y) })
  })

  // 文件区空白处右键：导入 / 新建分类
  ipcMain.on('library:blank-menu', (_e, x: number, y: number) => {
    if (!win) return
    const menu = Menu.buildFromTemplate([
      { label: '导入 PDF 文献…', click: () => win!.webContents.send('app:import-request', null) },
      { label: '新建分类…', click: () => win!.webContents.send('category:create-request', null) }
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

  // 分类右键菜单：重命名 / 导出 / 删除（仅空分类）
  ipcMain.on('category:menu', (_e, cat: string, x: number, y: number) => {
    if (!win) return
    const cnt = (dbmod.getDb().prepare('SELECT COUNT(*) AS n FROM papers WHERE category=?').get(cat) as { n: number }).n
    const menu = Menu.buildFromTemplate([
      {
        label: '重命名…',
        click: () => win!.webContents.send('category:rename-request', cat)
      },
      {
        label: '导出该分类…',
        click: () => void exportCategory(cat)
      },
      ...(cnt === 0
        ? [
            {
              label: '删除该空分类',
              click: () => {
                const libPapers = path.join(dbmod.getSettings().libraryPath, 'papers')
                try {
                  deleteCategory(cat, libPapers)
                  send('papers:changed', { ids: [] })
                } catch (err) {
                  dialog.showMessageBox(win!, { message: String(err) })
                }
              }
            } as Electron.MenuItemConstructorOptions
          ]
        : [])
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
    const lib = dbmod.getSettings().libraryPath
    const papersDir = path.join(lib, 'papers')
    const base = fs.existsSync(papersDir) ? papersDir : lib
    const eq = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
    // 磁盘上属于该分类的所有目录（分类名 = 目录名去掉 NN- 编号前缀；历史操作可能分裂成多个）
    const catDirs = fs
      .readdirSync(base)
      .filter((d) => !d.startsWith('.') && fs.statSync(path.join(base, d)).isDirectory() && eq(d.replace(/^\d+-/, ''), from))
    if (catDirs.length === 0) throw new Error(`未找到分类「${from}」的文件夹（可能已被移动）`)
    const prefix = catDirs[0].match(/^(\d+-)/)?.[1] ?? ''
    const target = path.join(base, `${prefix}${toSlug}`)
    const db = dbmod.getDb()
    const updPath = db.prepare('UPDATE papers SET path=? WHERE id=?')
    const rows = db.prepare('SELECT id, path FROM papers WHERE category=?').all(from) as Array<{ id: number; path: string }>
    for (const dir of catDirs) {
      const src = path.join(base, dir)
      if (eq(dir, path.basename(target))) continue
      fs.mkdirSync(target, { recursive: true })
      // 逐个论文目录并入目标（重名自动加 -N 后缀）；同步改写 DB 行的 path，
      // 保留行身份——阅读状态/高亮不丢，也不会触发整批重新嵌入
      for (const entry of fs.readdirSync(src)) {
        let dest = path.join(target, entry)
        let k = 2
        while (fs.existsSync(dest)) dest = path.join(target, `${entry}-${k++}`)
        fs.renameSync(path.join(src, entry), dest)
        for (const row of rows) {
          if (eq(path.dirname(path.dirname(row.path)), src)) updPath.run(path.join(dest, path.basename(row.path)), row.id)
        }
      }
      try {
        fs.rmdirSync(src) // 内容已全部并入，删掉空壳；有残留就留给扫描
      } catch {
        /* 目录非空 */
      }
    }
    db.prepare('UPDATE papers SET category=? WHERE category=?').run(toSlug, from)
    const r = dbmod.scanLibrary(lib)
    return { renamed: toSlug, scan: r }
  })

  ipcMain.handle('category:export', (_e, cat: string) => exportCategory(String(cat)))

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
    dbmod.getDb().exec('DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM papers_fts; UPDATE papers SET indexed=0, pvec=NULL')
    if (!isIndexRunning()) void buildIndex(send).catch((e) => send('index:error', String(e)))
    return true
  })
  ipcMain.on('index:start', () => {
    if (!isIndexRunning()) void buildIndex(send).catch((e) => send('index:error', String(e)))
  })

  // 连接测试：over = 渲染端当前编辑值（先保存再测会读到旧全局配置，正确 key 也测不过）
  ipcMain.handle('llm:test', (_e, over?: import('./llm').LlmEndpoint) => testLLM(over))
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
        paperIds?: number[]
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
            sources = await hybridSearch(args.question!, undefined, 16, args.category, args.paperIds)
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

  // ---------- 对话历史 ----------
  ipcMain.handle('chats:list', () => dbmod.listChats())
  ipcMain.handle('chat:load', (_e, id: number) => dbmod.loadChat(Number(id)))
  ipcMain.handle('chat:create', (_e, title: string) => dbmod.createChat(String(title ?? '')))
  ipcMain.handle('chat:append', (_e, id: number, role: string, content: string, sources?: string) => {
    if (typeof content !== 'string' || !content.trim()) return 0
    return dbmod.appendChatMsg(Number(id), String(role), content, sources)
  })
  ipcMain.handle('chat:rename', (_e, id: number, title: string) => {
    dbmod.renameChat(Number(id), String(title ?? ''))
    return true
  })
  ipcMain.handle('chat:delete', (_e, id: number) => {
    dbmod.deleteChat(Number(id))
    return true
  })
  // 整会话重写（问题编辑重生成后同步落库，单事务）
  ipcMain.handle('chat:set-messages', (_e, id: number, msgs: Array<{ role: string; content: string; sources?: unknown }>) => {
    dbmod.setChatMessages(
      Number(id),
      msgs.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content ?? ''), sources: m.sources }))
    )
    return true
  })

  // 本地字体列表（设置里选全局字体用）
  ipcMain.handle('fonts:list', () => listLocalFonts())

  // ---------- 版本与更新 ----------
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('update:check', async () => {
    const cur = app.getVersion()
    try {
      const r = await fetch('https://api.github.com/repos/XinyuanLiao/paperlens/releases/latest', {
        headers: { 'User-Agent': `paperlens/${cur}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000)
      })
      if (!r.ok) return { ok: false as const, current: cur, error: `GitHub API ${r.status}` }
      const j = (await r.json()) as { tag_name?: string; html_url?: string; body?: string; published_at?: string }
      const latest = (j.tag_name ?? '').replace(/^v/, '')
      if (!latest) return { ok: false as const, current: cur, error: 'release 信息缺失' }
      return {
        ok: true as const,
        current: cur,
        latest,
        url: j.html_url ?? 'https://github.com/XinyuanLiao/paperlens/releases/latest',
        notes: (j.body ?? '').slice(0, 2000),
        published: j.published_at ?? ''
      }
    } catch (err) {
      return { ok: false as const, current: cur, error: String(err).slice(0, 200) }
    }
  })
}
