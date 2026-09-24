import path from 'node:path'
import { deviceLabel, tfDeviceChain, type TfDevice } from './device'

// 本地嵌入：transformers.js + BAAI/bge-m3（ONNX q8，1024 维）。
// 首次使用自动下载到 model-cache，之后离线可用——无需任何配置。
// 加速设备自动选择（cuda/dml 优先、CPU 兜底），失败静默换下一设备。

export const EMBED_MODEL_ID = 'onnx:bge-m3-q8' // 索引版本键：变更触发全库重建

let extractorPromise: Promise<{ ex: any; device: TfDevice }> | null = null

async function getExtractor(): Promise<{ ex: any; device: TfDevice }> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      process.env.HF_ENDPOINT ||= 'https://hf-mirror.com' // 国内镜像
      const { pipeline, env } = await import('@huggingface/transformers')
      const { app } = await import('electron')
      // 模型缓存放 userData：打包后应用目录（asar）只读，默认缓存路径会写失败
      env.cacheDir = path.join(app.getPath('userData'), 'model-cache')
      let lastErr = ''
      for (const device of tfDeviceChain()) {
        try {
          const ex = await pipeline('feature-extraction', 'Xenova/bge-m3', { dtype: 'q8', device })
          console.log(`[embed] bge-m3 就绪 · ${deviceLabel(device)}`)
          return { ex, device }
        } catch (err) {
          lastErr = String(err)
          console.warn(`[embed] ${device} 不可用，尝试下一设备：`, lastErr.slice(0, 160))
        }
      }
      throw new Error(`bge-m3 加载失败：${lastErr.slice(0, 200)}`)
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

const BATCH = 8

export async function embed(texts: string[]): Promise<EmbedResult> {
  const { ex } = await getExtractor()
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
