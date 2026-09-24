import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getSettings } from './db'
import { markerBin } from './markerEnv'

// marker（datalab-to/marker，Python）把 PDF 转成结构化 markdown：
// 多栏/公式/表格的还原质量远高于内置 pdfjs 抽取，但需要本机 Python 环境。
// 这里只做 CLI 集成：逐篇运行 marker_single，md 结果按 pdf 哈希缓存，
// 失败/超时返回 null，由调用方（buildIndex）回退内置引擎。

// CPU 上大论文的 OCR 可能到分钟级；GPU（CUDA torch）通常 5-30s/篇
const MARKER_TIMEOUT_MS = 600_000

// marker 串行队列：每次运行都要加载 torch 模型（数 GB 内存），并发只会互相拖垮
let queueTail: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job, job)
  queueTail = run.catch(() => undefined)
  return run
}

export interface MdBlock {
  text: string
  // 章节编号（"3.2" / "III" / ""），参与检索加成与来源标注
  sectionNo: string
  sectionTitle: string
  kind: 'body' | 'abstract' | 'caption'
}

// Windows 下 Node spawn 不做 PATHEXT 解析：裸命令名补 .exe（pip 的 console_scripts 装的是 marker_single.exe）；
// 沙盒/手动指定的完整路径原样返回
function resolveCmd(cmd: string): string {
  if (process.platform !== 'win32') return cmd
  if (/\.(exe|cmd|bat)$/i.test(cmd) || cmd.includes('\\') || cmd.includes('/')) return cmd
  return `${cmd}.exe`
}

// 设置页「测试」按钮：探测 marker 可用性（手动命令 > 自动配置的沙盒 > PATH）
export async function testMarker(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const cmd = resolveCmd(markerBin(getSettings().markerCmd))
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let buf = ''
      const timer = setTimeout(() => {
        p.kill()
        reject(new Error('超时（10s）'))
      }, 10_000)
      p.stdout.on('data', (d) => (buf += d))
      p.stderr.on('data', (d) => (buf += d))
      p.on('error', reject)
      p.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(buf.trim())
        else reject(new Error(`退出码 ${code}：${buf.trim().slice(0, 200)}`))
      })
    })
    return { ok: true, version: out.split('\n')[0]?.slice(0, 60) || 'ok' }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) }
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // child.kill() 不杀子进程（marker/torch 会派生 worker），taskkill 按进程树清
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined)
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

// 运行 marker_single 转出 markdown；缓存命中直接返回，失败返回 null（调用方回退内置引擎）
export async function runMarker(pdfPath: string): Promise<string | null> {
  const { app } = await import('electron')
  const s = getSettings()
  const cmd = resolveCmd(markerBin(s.markerCmd))
  let st: fs.Stats
  try {
    st = fs.statSync(pdfPath)
  } catch {
    return null
  }
  const key = crypto
    .createHash('sha1')
    .update(`${path.resolve(pdfPath).toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex')
  const cacheDir = path.join(app.getPath('userData'), 'marker-cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const cacheFile = path.join(cacheDir, `${key}.md`)
  try {
    const hit = fs.readFileSync(cacheFile, 'utf8')
    if (hit.trim()) return hit
  } catch {
    /* 未缓存 */
  }

  return enqueue(
    () =>
      new Promise<string | null>((resolve) => {
        const tmpDir = fs.mkdtempSync(path.join(cacheDir, 'tmp-'))
        // 加速设备交给 torch 自动检测（Windows/Linux CUDA、macOS MPS、低端配置 CPU）
        const p = spawn(resolveCmd(cmd), [pdfPath, '--output_dir', tmpDir, '--disable_image_extraction'], {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
          ...(process.platform !== 'win32' ? { detached: true } : {})
        })
        let errBuf = ''
        let settled = false
        p.stderr?.on('data', (d) => {
          errBuf += d
          if (errBuf.length > 4000) errBuf = errBuf.slice(-2000)
        })
        const done = (result: string | null): void => {
          if (settled) return // spawn 失败会同时触发 error 与 close
          settled = true
          clearTimeout(timer)
          // Windows：taskkill 后句柄释放有延迟，rmSync 立即执行会 EBUSY，重试几轮
          for (let i = 0; i < 4; i++) {
            try {
              fs.rmSync(tmpDir, { recursive: true, force: true })
              break
            } catch {
              if (i === 3) console.warn(`[marker] 临时目录残留: ${tmpDir}`)
              else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600)
            }
          }
          resolve(result)
        }
        const timer = setTimeout(() => {
          killTree(p.pid ?? 0)
          done(null)
        }, MARKER_TIMEOUT_MS)
        p.on('error', (err) => {
          console.error('[marker] 启动失败（未安装或命令不对）:', String(err))
          done(null)
        })
        p.on('close', (code) => {
          if (code !== 0) {
            // stderr 里 tqdm 进度条占绝大多数（\r 刷新），过滤后才看得到真错误
            const errLines = errBuf
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => l && !/\d+%\|/.test(l) && !/\/it\]|it\/s\]/.test(l))
            console.error(`[marker] 退出码 ${code}: ${errLines.slice(-6).join(' | ').slice(0, 300)}`)
            done(null)
            return
          }
          // marker 1.x 把结果放在 output_dir/<pdf名>/<pdf名>.md（版本间层级有差异，递归找第一个 .md）
          const findMd = (dir: string): string => {
            let best = ''
            for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
              if (f.isFile() && f.name.toLowerCase().endsWith('.md')) return path.join(dir, f.name)
              if (f.isDirectory()) {
                const sub = findMd(path.join(dir, f.name))
                if (sub && (!best || sub.length < best.length)) best = sub
              }
            }
            return best
          }
          let md = ''
          try {
            md = findMd(tmpDir)
            if (md) md = fs.readFileSync(md, 'utf8')
          } catch {
            /* 读取失败按空处理 */
          }
          if (!md.trim()) {
            done(null)
            return
          }
          try {
            fs.writeFileSync(cacheFile, md)
          } catch {
            /* 缓存写失败不影响本次结果 */
          }
          done(md)
        })
      })
  )
}

// ---------- markdown → 结构块 ----------

// 尾部章节（参考文献/致谢/作者简介）：块直接丢弃，不进索引
const BACK_MATTER_HEADING =
  /^(?:references?(?:\s+cited)?|bibliography|acknowledg?ments?|author\s+biographies?|biograph(?:y|ies)|参考文献|致\s*谢|作者简介)/i
// 参考文献之后可能还有附录，遇到则恢复收录
const APPENDIX_HEADING = /^(?:appendix|appendices|supplementary|附\s*录)/i
const ABSTRACT_HEADING = /^(?:abstract|summary|摘\s*要)\b/i
const CAPTION_RE = /^(?:figure|fig\.|table|图|表)\s*\d+/i
// 章节编号：阿拉伯（3.2 / 3.2.1）、罗马（III.）、中文（第三章）
const NUM_ARABIC = /^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/
const NUM_ROMAN = /^(ix|iv|v?i{1,3})\.\s+(.*)$/i
const NUM_CN = /^第([一二三四五六七八九十百\d]+)章\s*(.*)$/

/** 把 marker markdown 解析为带章节元数据的顺序块（标题/摘要/正文/图表题注） */
export function parseMdBlocks(md: string): MdBlock[] {
  const blocks: MdBlock[] = []
  let sectionNo = ''
  let sectionTitle = ''
  let kind: MdBlock['kind'] = 'body'
  let skipping = false
  let inFront = true // 首个标题之前的内容（题名/作者/关键词）整体视为摘要区
  let buf: string[] = []
  let fenceBuf: string[] | null = null // 公式/代码围栏：整块保留原始换行

  const flush = (): void => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim()
    buf = []
    if (!text || skipping) return
    blocks.push({
      text,
      sectionNo,
      sectionTitle,
      kind: CAPTION_RE.test(text) && kind === 'body' ? 'caption' : kind
    })
  }

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd()
    if (/^(```|~~~)/.test(line.trim())) {
      if (fenceBuf) {
        fenceBuf.push(line.trim())
        const text = fenceBuf.join('\n').trim()
        if (text && !skipping) {
          blocks.push({ text, sectionNo, sectionTitle, kind: kind === 'abstract' ? 'abstract' : 'body' })
        }
        fenceBuf = null
      } else {
        flush()
        fenceBuf = [line.trim()]
      }
      continue
    }
    if (fenceBuf) {
      fenceBuf.push(line)
      continue
    }
    const hm = line.match(/^(#{1,6})\s+(.*)$/)
    if (hm) {
      flush()
      const title = hm[2].replace(/[*_`#]/g, '').trim()
      if (BACK_MATTER_HEADING.test(title)) {
        skipping = true
        continue
      }
      if (APPENDIX_HEADING.test(title)) {
        skipping = false
        sectionNo = 'Appendix'
        sectionTitle = title
        kind = 'body'
        inFront = false
        continue
      }
      skipping = false
      inFront = false
      const am = title.match(NUM_ARABIC)
      const rm = title.match(NUM_ROMAN)
      const cm = title.match(NUM_CN)
      if (am) {
        sectionNo = am[1]
        sectionTitle = am[2].trim()
      } else if (rm) {
        sectionNo = rm[1].toUpperCase()
        sectionTitle = rm[2].trim()
      } else if (cm) {
        sectionNo = cm[1]
        sectionTitle = cm[2].trim() || `第${cm[1]}章`
      } else {
        sectionNo = ''
        sectionTitle = title
      }
      kind = ABSTRACT_HEADING.test(title) ? 'abstract' : 'body'
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    // 图片/纯链接行没有检索价值，直接跳过
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(line.trim())) continue
    if (inFront) kind = 'abstract'
    buf.push(line.trim())
  }
  flush()
  return blocks.filter((b) => b.text.length > 8)
}

// ---------- 页码对齐 ----------
// marker 输出不带页码，而引用跳转依赖页码：用块文本在 pdfjs 逐页文本上做
// 归一化子串/bigram-Dice 匹配回填。块与页都是有序的，游标单调前进即可。

export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\-–—_/\\]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0
  const sb = bigrams(b)
  let hit = 0
  for (let i = 0; i < a.length - 1; i++) if (sb.has(a.slice(i, i + 2))) hit++
  return (2 * hit) / (a.length - 1 + b.length - 1)
}

// 为每个块回填页码（1 起；对不上的块返回 0，来源芯片退化为只打开论文不带页跳转）
export function alignBlocksToPages(blocks: MdBlock[], pages: string[]): Array<{ block: MdBlock; page: number }> {
  if (!pages.length) return blocks.map((block) => ({ block, page: 0 }))
  const normPages = pages.map((p) => normText(p))
  let cursor = 0 // 上一个命中的页下标，从此页向后找（块与页都单调有序）
  return blocks.map((block) => {
    const probe = normText(block.text).slice(0, 120)
    if (probe.length < 16) return { block, page: 0 }
    let page = 0
    let best = 0
    for (let i = cursor; i < normPages.length; i++) {
      const np = normPages[i]
      if (np.includes(probe.slice(0, 80))) {
        page = i + 1
        best = 1
        break
      }
      const d = dice(probe, np.length > 3000 ? np.slice(0, 3000) : np)
      if (d > best) {
        best = d
        page = i + 1
      }
    }
    if (best < 0.3) page = 0
    if (page > 0) cursor = page - 1
    return { block, page }
  })
}
