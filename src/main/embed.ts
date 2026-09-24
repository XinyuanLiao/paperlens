// 本地嵌入：由 Ollama 管理与调用（/api/embed），模型在 Ollama 侧 pull，应用内无需下载管理。
// 向量统一 L2 归一化（余弦 = 点积）。模型名变更会通过 embedModelId 触发全库重建。

import { getSettings } from './db'

export function embedModelId(): string {
  // 索引版本键：换 Ollama 模型时旧向量空间不可比
  const m = embedConfig().model
  return `ollama:${m}`
}

interface EmbedCfg {
  url: string
  model: string
}

function embedConfig(): EmbedCfg {
  const s = getSettings()
  return { url: (s.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, ''), model: s.ollamaEmbedModel || 'qwen3-embedding:0.6b' }
}

export interface EmbedResult {
  vectors: number[][]
  dim: number
}

const BATCH = 32

function normalize(v: number[]): number[] {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

export async function embed(texts: string[]): Promise<EmbedResult> {
  const { url, model } = embedConfig()
  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const resp = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch }),
      signal: AbortSignal.timeout(120_000)
    })
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      throw new Error(
        resp.status === 404 || /not found/i.test(t)
          ? `Ollama 缺少模型 ${model}（执行 ollama pull ${model}）`
          : `Ollama 嵌入 ${resp.status}: ${t.slice(0, 160)}`
      )
    }
    const json = (await resp.json()) as { embeddings: number[][] }
    vectors.push(...json.embeddings.map(normalize))
  }
  return { vectors, dim: vectors[0]?.length ?? 0 }
}

export function cosSim(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // 归一化向量点积即余弦
}
