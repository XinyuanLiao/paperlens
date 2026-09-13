import path from 'node:path'
import { getSettings } from './db'

// 本地嵌入：transformers.js + multilingual-e5-small（384 维，q8 量化约 130MB，首次运行下载）
let extractorPromise: Promise<any> | null = null

async function getLocalExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      process.env.HF_ENDPOINT ||= 'https://hf-mirror.com' // 国内镜像
      const { pipeline, env } = await import('@huggingface/transformers')
      const { app } = await import('electron')
      // 模型缓存放进 userData：打包后应用目录（asar）只读，默认缓存路径会写失败
      env.cacheDir = path.join(app.getPath('userData'), 'model-cache')
      return pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })
    })()
    extractorPromise.catch(() => {
      extractorPromise = null // 失败允许重试
    })
  }
  return extractorPromise
}

export interface EmbedResult {
  vectors: number[][]
  dim: number
}

export async function embed(texts: string[], isQuery = false): Promise<EmbedResult> {
  const s = getSettings()
  if (s.embedProvider === 'zhipu' && s.apiKey) {
    // 智谱 embedding-3：批量上限 64
    const vectors: number[][] = []
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64)
      const resp = await fetch(`${s.apiBase}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify({ model: 'embedding-3', input: batch })
      })
      if (!resp.ok) throw new Error(`Embedding API ${resp.status}: ${await resp.text()}`)
      const json = (await resp.json()) as { data: Array<{ embedding: number[] }> }
      vectors.push(...json.data.map((d) => d.embedding))
    }
    return { vectors: vectors.map(normalize), dim: vectors[0]?.length ?? 0 }
  }
  if (s.embedProvider === 'ollama') {
    // Ollama /api/embed：{model, input:[...]} → {embeddings:[[...]]}
    const vectors: number[][] = []
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32)
      const resp = await fetch(`${s.ollamaUrl.replace(/\/$/, '')}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: s.ollamaEmbedModel, input: batch })
      })
      if (!resp.ok) throw new Error(`Ollama embed ${resp.status}: ${await resp.text()}（确认已 ollama pull ${s.ollamaEmbedModel}）`)
      const json = (await resp.json()) as { embeddings: number[][] }
      vectors.push(...json.embeddings.map(normalize))
    }
    return { vectors, dim: vectors[0]?.length ?? 0 }
  }
  const ex = await getLocalExtractor()
  const input = texts.map((t) => (isQuery ? 'query: ' : 'passage: ') + t)
  const out = await ex(input, { pooling: 'mean', normalize: true })
  return { vectors: out.tolist() as number[][], dim: (out.dims as number[])[out.dims.length - 1] }
}

function normalize(v: number[]): number[] {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

export function cosSim(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // 归一化向量点积即余弦
}
