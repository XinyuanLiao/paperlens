import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { download, extract } from './dl'

// 向量引擎：llama.cpp（安装时自动下载二进制 + bge-m3 GGUF；已就绪则直接调用不重复下载）。
// llama-server sidecar 常驻（--embedding --pooling cls），HTTP /v1/embeddings 出向量。
// 设备：Windows 有 N 卡走 CUDA 构建（含 cudart 自带运行库），无卡用 CPU 构建；
// macOS 用 Metal 构建（官方 macos 包内置）；低端配置自然落在 CPU 构建上。
// （选 llama.cpp 而非 onnxruntime 的原因：后者 Windows 只有 DirectML、macOS 无 GPU 后端。）

export type RuntimeState = 'need' | 'downloading' | 'ready' | 'running' | 'error'

export interface RuntimeStatus {
  state: RuntimeState
  detail: string
  device: string
  pct?: number
}

// 进度事件汇（index.ts 注册，转发给渲染端 runtime:progress）
let sink: ((s: RuntimeStatus) => void) | null = null
export function onRuntimeStatus(cb: (s: RuntimeStatus) => void): void {
  sink = cb
}

const MODEL_URLS = [
  // bge-m3 GGUF（1024 维，XLM-RoBERTa，CLS 池化）。实测选型（2026-09-24）：
  // gpustack 转换版词表完整（中文/换行/全角标点全过，EN/中文区分度 0.4+）；
  // vonjack 版 SPM 词表缺中文与换行键（中文直接 500），禁用
  'https://hf-mirror.com/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q6_K.gguf',
  'https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q6_K.gguf',
  'https://hf-mirror.com/walsons/bge-m3.gguf/resolve/main/bge-m3-q8_0.gguf'
]

function aiRoot(): string {
  const { app } = require('electron') as typeof import('electron')
  return path.join(app.getPath('userData'), 'ai-runtime')
}
const binDir = (): string => path.join(aiRoot(), 'bin')
const modelPath = (): string => path.join(aiRoot(), 'models', 'bge-m3-q8.gguf')

let status: RuntimeStatus = { state: 'need', detail: '', device: '' }
function setStatus(s: RuntimeStatus): void {
  status = s
  sink?.(s)
}
export function llamaStatus(): RuntimeStatus {
  return status
}

// llama-server 可执行文件（zip/tar 解开后可能在根或 bin/ 子目录）
function findServer(): string | null {
  const names = process.platform === 'win32' ? ['llama-server.exe'] : ['llama-server']
  for (const dir of [binDir(), path.join(binDir(), 'bin')]) {
    for (const n of names) {
      const p = path.join(dir, n)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

function haveModel(): boolean {
  try {
    return fs.statSync(modelPath()).size > 1e8
  } catch {
    return false
  }
}

async function hasNvidiaGpu(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        resolve(!err && /GPU/.test(stdout))
      })
    } catch {
      resolve(false)
    }
  })
}

// 解析 llama.cpp nightly 发布（latest 是占位 tag，真资产在 b11xxx 这类 tag 下）
async function pickAssets(): Promise<{ bins: string[]; device: string }> {
  const resp = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8', {
    headers: { 'User-Agent': 'PaperLens' }
  })
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}`)
  const releases = (await resp.json()) as Array<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }>
  const rel = releases.find((r) => r.assets.length > 20)
  if (!rel) throw new Error('未找到带二进制的 llama.cpp 发布')
  const byName = (re: RegExp): string | null => rel.assets.find((a) => re.test(a.name))?.browser_download_url ?? null
  const t = rel.tag_name
  if (process.platform === 'win32') {
    if (await hasNvidiaGpu()) {
      // CUDA 构建 + 官方 cudart 自包含运行库（免装 CUDA Toolkit）
      const bin = byName(new RegExp(`^llama-${t}-bin-win-cuda-[\\d.]+-x64\\.zip$`)) ?? byName(/win-cuda-[\d.]+-x64\.zip$/)
      const cudart = byName(/cudart-llama-bin-win-cuda-[\d.]+-x64\.zip$/)
      if (bin && cudart) return { bins: [bin, cudart], device: 'CUDA' }
    }
    const cpu = byName(new RegExp(`^llama-${t}-bin-win-cpu-x64\\.zip$`)) ?? byName(/win-cpu-x64\.zip$/)
    if (cpu) return { bins: [cpu], device: 'CPU' }
  } else if (process.platform === 'darwin') {
    const m = byName(new RegExp(`^llama-${t}-bin-macos-${os.arch() === 'arm64' ? 'arm64' : 'x64'}\\.tar\\.gz$`)) ?? byName(/bin-macos-(arm64|x64)\.tar\.gz$/)
    if (m) return { bins: [m], device: 'Metal' }
  }
  const cpu = byName(/bin-(ubuntu|linux)-cpu-x64\.tar\.gz$/) ?? byName(/cpu-x64\.tar\.gz$/)
  if (cpu) return { bins: [cpu], device: 'CPU' }
  throw new Error('没有匹配本平台的 llama.cpp 构建')
}

// 首次安装：下载二进制（CUDA/CPU/Metal 三选一）+ bge-m3 GGUF。已就绪则直接返回（"已有直接调用"）。
// 并发去重：多处同时触发也只跑一次
let ensureInflight: Promise<boolean> | null = null
export function ensureLlamaRuntime(force = false): Promise<boolean> {
  if (ensureInflight) return ensureInflight
  ensureInflight = doEnsure(force).finally(() => {
    ensureInflight = null
  })
  return ensureInflight
}

async function doEnsure(force: boolean): Promise<boolean> {
  if (!force && findServer() && haveModel()) {
    setStatus({ state: 'ready', detail: '已安装', device: status.device || '' })
    return true
  }
  try {
    setStatus({ state: 'downloading', detail: '解析下载源…', device: '' })
    const { bins, device } = await pickAssets()
    fs.mkdirSync(binDir(), { recursive: true })
    for (const url of bins) {
      const name = url.split('/').pop()!
      const dest = path.join(aiRoot(), 'dl', name)
      await download(url, dest, (got, total) =>
        setStatus({ state: 'downloading', detail: `下载 ${name}`, device, pct: total ? Math.floor((got / total) * 100) : undefined })
      )
      // cudart 并入同一目录供 DLL 解析（tar/PowerShell 双路解压见 dl.extract）
      await extract(dest, binDir())
    }
    setStatus({ state: 'downloading', detail: '下载 bge-m3 模型（约 600MB）…', device })
    let modelErr = ''
    for (const url of MODEL_URLS) {
      try {
        await download(url, modelPath(), (got, total) =>
          setStatus({ state: 'downloading', detail: '下载 bge-m3 模型', device, pct: total ? Math.floor((got / total) * 100) : undefined })
        )
        break
      } catch (err) {
        modelErr = String(err)
      }
    }
    if (!haveModel()) throw new Error(`模型下载失败：${modelErr.slice(0, 120)}`)
    setStatus({ state: 'ready', detail: '已安装', device })
    return true
  } catch (err) {
    setStatus({ state: 'error', detail: String(err).slice(0, 160), device: '' })
    return false
  }
}

// ---------- sidecar ----------
let serverProc: ReturnType<typeof spawn> | null = null
let serverReady: Promise<boolean> | null = null
let port = 0

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

async function startServer(): Promise<boolean> {
  if (serverReady) return serverReady
  serverReady = (async () => {
    const exe = findServer()
    if (!exe || !haveModel()) {
      const ok = await ensureLlamaRuntime()
      if (!ok) return false
    }
    const server = findServer()
    if (!server) return false
    port = await freePort()
    const child = spawn(
      server,
      ['-m', modelPath(), '--embedding', '--pooling', 'cls', '-c', '2048', '--port', String(port), '--host', '127.0.0.1'],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    serverProc = child
    child.stderr?.on('data', (d) => {
      const t = String(d)
      if (/error|fail/i.test(t)) console.warn('[llama]', t.split('\n').slice(-2).join(' ').slice(0, 200))
    })
    child.on('exit', () => {
      serverProc = null
      serverReady = null
    })
    // 等 /health 就绪（模型加载 ~2-5s）
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) {
          setStatus({ state: 'running', detail: `运行中（${status.device || '自动'}）`, device: status.device })
          return true
        }
      } catch {
        /* 未就绪 */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    shutdownLlama()
    return false
  })()
  return serverReady
}

export function shutdownLlama(): void {
  if (serverProc?.pid) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true })
      else process.kill(-serverProc.pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
  serverProc = null
  serverReady = null
}

function normalize(v: number[]): number[] {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

// 嵌入一批文本（返回 L2 归一化向量）；sidecar 未起则自动起，未安装则自动下载
export async function llamaEmbed(texts: string[]): Promise<number[][]> {
  const ok = await startServer()
  if (!ok) throw new Error('llama.cpp 向量引擎不可用')
  const resp = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: 'bge-m3' }),
    signal: AbortSignal.timeout(120_000)
  })
  if (!resp.ok) throw new Error(`向量引擎 ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 160)}`)
  const json = (await resp.json()) as { data: Array<{ embedding: number[] }> }
  return json.data.map((d) => normalize(d.embedding))
}

export function testLlamaRuntime(): Promise<{ ok: boolean; device?: string; dim?: number; error?: string }> {
  return (async () => {
    try {
      await ensureLlamaRuntime()
      const [a, b] = await llamaEmbed(['connection test', '链接测试'])
      return { ok: true, device: status.device || '自动', dim: a.length, ...((b.length !== a.length) ? { error: '维度不一致' } : {}) }
    } catch (err) {
      return { ok: false, error: String(err).slice(0, 200) }
    }
  })()
}
