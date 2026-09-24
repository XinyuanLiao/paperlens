import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// 通用下载器：断点续传 + 失败重试 + 进度回调（大文件走镜像容易中途断流，Range 续传是刚需）。
// 所有 AI 运行时组件（llama.cpp / GGUF / uv / 模型）都从这里走。

export type DlProgress = (received: number, total: number) => void

const UA = 'PaperLens/1.0 (electron app runtime downloader)'

async function once(url: string, dest: string, onProgress?: DlProgress): Promise<void> {
  const part = `${dest}.part`
  let have = 0
  try {
    have = fs.statSync(part).size
  } catch {
    /* 首次下载 */
  }
  const headers: Record<string, string> = { 'User-Agent': UA }
  if (have > 0) headers.Range = `bytes=${have}-`
  const resp = await fetch(url, { headers, redirect: 'follow' })
  if (resp.status === 416) {
    // 续传点已到文件末尾（上次下完但没改名）
    fs.renameSync(part, dest)
    return
  }
  if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status} ${url.slice(0, 120)}`)
  const total = have + (Number(resp.headers.get('content-length')) || 0)
  const body = resp.body
  if (!body) throw new Error('empty body')
  const out = fs.createWriteStream(part, { flags: have > 0 && resp.status === 206 ? 'a' : 'w' })
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // 背压：磁盘慢于网络时不等待会把整文件堆在内存里
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r))
      have += value.byteLength
      onProgress?.(have, total)
    }
  } finally {
    await new Promise((r) => out.end(r))
  }
  fs.renameSync(part, dest)
}

// 下载到 dest（.part 断点续传，最多 5 轮重试）；已存在且非空直接跳过（"已有直接调用"）
export async function download(url: string, dest: string, onProgress?: DlProgress): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return
  let lastErr = ''
  for (let i = 0; i < 5; i++) {
    try {
      await once(url, dest, onProgress)
      return
    } catch (err) {
      lastErr = String(err)
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw new Error(`下载失败（已重试 5 次）：${lastErr.slice(0, 160)}`)
}

// 解压 zip / tar.gz 到 destDir：先试 tar（Win10+ 自带 bsdtar），失败落 PowerShell Expand-Archive。
// 坑：从 Git Bash 启动的进程 PATH 里是 GNU tar，不认 zip——兜底是刚需不是保险
export async function extract(archive: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  const tar = (): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile('tar', ['-xf', archive, '-C', destDir], { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
    })
  try {
    await tar()
  } catch (err) {
    if (process.platform === 'win32' && /\.zip$/i.test(archive)) {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -Force '${archive.replace(/'/g, "''")}' '${destDir.replace(/'/g, "''")}'`],
          { windowsHide: true },
          (e) => (e ? reject(e) : resolve())
        )
      })
    } else throw err
  }
}
