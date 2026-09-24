import path from 'node:path'
import { deviceLabel, tfDeviceChain, type TfDevice } from './device'
import { llamaEmbed } from './llamacpp'

// 本地嵌入：主路径 llama.cpp + BAAI/bge-m3 GGUF（安装时自动下载，已就绪直接调用；
// CLS 池化，1024 维，实测区分度优于 mean）。llama.cpp 不可用时回退 ONNX q8（transformers.js）。
// 加速设备自动选择：Windows CUDA/CPU、macOS Metal、低端 CPU（llama.cpp 侧），ONNX 侧 cuda/dml/gpu→cpu。

export const EMBED_MODEL_ID = 'llama.cpp:bge-m3-q6k@cls' // 索引版本键：变更触发全库重建

// ---------- ONNX 兜底（llama.cpp 缺失/失败时） ----------
let extractorPromise: Promise<{ ex: any; device: TfDevice }> | null = null

async function getOnnxExtractor(): Promise<{ ex: any; device: TfDevice }> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      process.env.HF_ENDPOINT ||= 'https://hf-mirror.com' // 国内镜像
      const { pipeline, env } = await import('@huggingface/transformers')
      const { app } = await import('electron')
      // 模型缓存放 userData：打包后应用目录（asar）只读，默认缓存路径会写失败
      env.cacheDir = path.join(app.getPath('userData'), 'model-cache')
      const chain = tfDeviceChain()
      let lastErr = ''
      for (const device of chain) {
        try {
          const ex = await pipeline('feature-extraction', 'Xenova/bge-m3', { dtype: 'q8', device })
          console.log(`[embed] ONNX bge-m3 兜底就绪 · ${deviceLabel(device)}`)
          return { ex, device }
        } catch (err) {
          lastErr = String(err)
          console.warn(`[embed] ONNX ${device} 不可用，尝试下一设备：`, lastErr.slice(0, 160))
        }
      }
      throw new Error(`ONNX 兜底加载失败：${lastErr.slice(0, 200)}`)
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

const BATCH = 8 // 逐 8 条一批（llama-server/ONNX 吞吐与内存均衡）

// llama 路径一旦失败，本会话固定走 ONNX 兜底：两个模型的向量空间不同，
// 同一索引里混用会让检索彻底失真，宁可整会话统一降级
let llamaBroken = false

export async function embed(texts: string[]): Promise<EmbedResult> {
  if (!llamaBroken) {
    try {
      const vectors: number[][] = []
      for (let i = 0; i < texts.length; i += BATCH) {
        vectors.push(...(await llamaEmbed(texts.slice(i, i + BATCH))))
      }
      return { vectors, dim: vectors[0]?.length ?? 0 }
    } catch (err) {
      llamaBroken = true
      console.warn('[embed] llama.cpp 路径失败，本会话固定回退 ONNX（避免向量空间混用）：', String(err).slice(0, 160))
    }
  }
  const { ex } = await getOnnxExtractor()
  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const out = await ex(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true })
    vectors.push(...(out.tolist() as number[][]))
  }
  return { vectors, dim: vectors[0]?.length ?? 0 }
}

export function cosSim(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // 归一化向量点积即余弦
}
