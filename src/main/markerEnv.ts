import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { download, extract } from './dl'

// marker 解析环境：安装时自动配置一个独立 Python 沙盒（uv 引导），内置支持 CUDA（Windows/Linux）
// 或 MPS（macOS）的 PyTorch——torch/torchvision 必须同渠道成对装，否则 torchvision::nms 报错。
// 已配置则直接调用（markerBin() 解析到沙盒内 marker_single），设置里手动指定命令则优先手动值。

export type MarkerEnvState = 'need' | 'downloading' | 'installing' | 'ready' | 'error'

export interface MarkerEnvStatus {
  state: MarkerEnvState
  detail: string
  pct?: number
}

let status: MarkerEnvStatus = { state: 'need', detail: '' }
let sink: ((s: MarkerEnvStatus) => void) | null = null
export function onMarkerEnvStatus(cb: (s: MarkerEnvStatus) => void): void {
  sink = cb
}
function setStatus(s: MarkerEnvStatus): void {
  status = s
  sink?.(s)
}
export function markerEnvStatus(): MarkerEnvStatus {
  // 惰性现实校验：跳过 ensure 直接复用沙盒时状态对象还是初值，不能显示成"未安装"
  if (status.state !== 'ready' && markerEnvReady()) return { state: 'ready', detail: '沙盒已配置' }
  return status
}

function aiRoot(): string {
  const { app } = require('electron') as typeof import('electron')
  return path.join(app.getPath('userData'), 'ai-runtime')
}
const uvDir = (): string => path.join(aiRoot(), 'uv')
const uvBin = (): string => path.join(uvDir(), process.platform === 'win32' ? 'uv.exe' : 'uv')
const envDir = (): string => path.join(aiRoot(), 'marker-env')

// 沙盒里的 marker_single 路径（平台差异：Scripts/ vs bin/）
export function sandboxMarkerBin(): string {
  return process.platform === 'win32'
    ? path.join(envDir(), 'Scripts', 'marker_single.exe')
    : path.join(envDir(), 'bin', 'marker_single')
}

export function markerEnvReady(): boolean {
  return fs.existsSync(sandboxMarkerBin())
}

// 实际执行的 marker 命令：手动指定 > 沙盒 > PATH
export function markerBin(custom: string): string {
  const c = (custom || '').trim()
  if (c) return c
  return markerEnvReady() ? sandboxMarkerBin() : 'marker_single'
}

async function ensureUv(): Promise<void> {
  if (fs.existsSync(uvBin())) return
  const arch = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin') : 'x86_64-pc-windows-msvc'
  const file = process.platform === 'win32' ? `uv-${arch}.zip` : `uv-${arch}.tar.gz`
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${file}`
  const dest = path.join(aiRoot(), 'dl', file)
  setStatus({ state: 'downloading', detail: '下载 uv 环境管理器…' })
  await download(url, dest)
  await extract(dest, uvDir())
  if (!fs.existsSync(uvBin())) throw new Error('uv 解压后未找到可执行文件')
}

function run(cmd: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let errBuf = ''
    p.stderr?.on('data', (d) => {
      errBuf += d
      if (errBuf.length > 3000) errBuf = errBuf.slice(-1500)
    })
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
      else if (p.pid) process.kill(-p.pid, 'SIGKILL')
      reject(new Error(`${label} 超时`))
    }, 20 * 60_000)
    p.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${label} 失败（退出码 ${code}）：${errBuf.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 240)}`))
    })
  })
}

// 配置沙盒：uv venv → 装 marker-pdf<2 → （Win/Linux）重装 CUDA 版 torch+torchvision 成对。
// macOS 自带 MPS 支持无需换。已就绪则直接返回（"已有直接调用"）。
// 并发去重：多处同时触发也只跑一次
let ensureInflight: Promise<boolean> | null = null
export function ensureMarkerEnv(force = false): Promise<boolean> {
  if (ensureInflight) return ensureInflight
  ensureInflight = doEnsure(force).finally(() => {
    ensureInflight = null
  })
  return ensureInflight
}

async function doEnsure(force: boolean): Promise<boolean> {
  if (!force && markerEnvReady()) {
    setStatus({ state: 'ready', detail: '沙盒已配置' })
    return true
  }
  try {
    await ensureUv()
    if (!fs.existsSync(path.join(envDir(), 'pyvenv.cfg'))) {
      setStatus({ state: 'installing', detail: '创建 Python 沙盒…' })
      await run(uvBin(), ['venv', '--python', '3.12', envDir()], '创建沙盒')
    }
    setStatus({ state: 'installing', detail: '安装 marker-pdf（首次约数分钟）…' })
    await run(uvBin(), ['pip', 'install', '--python', envDir(), 'marker-pdf<2'], '安装 marker-pdf')
    if (process.platform !== 'darwin') {
      // 成对重装 CUDA 版 torch/torchvision（只装 torch 会与 cpu 版 torchvision 二进制不匹配）
      setStatus({ state: 'installing', detail: '安装 CUDA 版 PyTorch（约 2-3GB）…' })
      await run(
        uvBin(),
        ['pip', 'install', '--python', envDir(), '--reinstall', 'torch', 'torchvision', '--index-url', 'https://download.pytorch.org/whl/cu128'],
        '安装 CUDA PyTorch'
      )
    }
    if (!markerEnvReady()) throw new Error('沙盒安装完成但未找到 marker_single')
    setStatus({ state: 'ready', detail: '沙盒已配置' })
    return true
  } catch (err) {
    setStatus({ state: 'error', detail: String(err).slice(0, 200) })
    return false
  }
}

export function testMarkerEnv(): Promise<{ ok: boolean; version?: string; error?: string }> {
  return (async () => {
    const cmd = markerBin('')
    return new Promise((resolve) => {
      const p = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let buf = ''
      const timer = setTimeout(() => {
        p.kill()
        resolve({ ok: false, error: '超时（10s）' })
      }, 10_000)
      p.stdout.on('data', (d) => (buf += d))
      p.stderr.on('data', (d) => (buf += d))
      p.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, error: `${String(err).slice(0, 120)}（未安装可先「配置解析环境」）` })
      })
      p.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0 ? { ok: true, version: buf.trim().split('\n')[0]?.slice(0, 60) || 'ok' } : { ok: false, error: `退出码 ${code}` })
      })
    })
  })()
}
