import path from 'node:path'
import { getSettings } from './db'
import { deviceLabel, tfDeviceChain, type TfDevice } from './device'

// 本地重排序：bge-reranker-v2-m3（ONNX），transformers.js 在主进程推理。
// 策略极简：候选打乱无关——调用方给 N 个候选，这里返回每对 (query, doc) 的 sigmoid 分数，
// 由调用方按分数取 top-K。加速设备自动选择（cuda/dml/gpu 优先，CPU 兜底；GPU 用 fp16、CPU 用 q8）。
// 注意不能用 text-classification pipeline：单 logit 交叉编码器会被 softmax 归一成恒 1.0，
// 必须手动取 logits 过 sigmoid。

const RERANK_MODEL = 'onnx-community/bge-reranker-v2-m3-ONNX'
const SCORE_WAIT_MS = 8000 // 单次检索里重排的等待预算（不含首次模型加载）
const MAX_DOC_CHARS = 1200 // 文档侧截断（重排对长文不敏感，省时省显存）

export function rerankEnabled(): boolean {
  return getSettings().rerankProvider === 'local'
}

interface Loaded {
  model: any
  tokenizer: any
  device: TfDevice
}

let modelPromise: Promise<Loaded | null> | null = null
let loadedModel: Loaded | null = null

export function currentDeviceLabel(): string | null {
  return loadedModel ? deviceLabel(loadedModel.device) : null
}

// 当前生效设备（null = 还没加载）；检索策略据此选完整/轻量重排
export function rerankDevice(): TfDevice | null {
  return loadedModel?.device ?? null
}

// GPU 设备用 fp16（快且省显存），CPU 用 q8（省内存）；逐级尝试失败落下一设备
const dtypeFor = (d: TfDevice): 'fp16' | 'q8' => (d === 'cpu' ? 'q8' : 'fp16')

async function loadModel(): Promise<Loaded | null> {
  process.env.HF_ENDPOINT ||= 'https://hf-mirror.com' // 国内镜像
  const { AutoModel, AutoTokenizer, env } = await import('@huggingface/transformers')
  const { app } = await import('electron')
  // 模型缓存与嵌入共用 userData/model-cache（打包后 asar 只读）
  env.cacheDir = path.join(app.getPath('userData'), 'model-cache')
  for (const device of tfDeviceChain()) {
    try {
      const model = await AutoModel.from_pretrained(RERANK_MODEL, { dtype: dtypeFor(device), device })
      const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL)
      loadedModel = { model, tokenizer, device }
      console.log(`[rerank] bge-reranker-v2-m3 就绪 · ${deviceLabel(device)}`)
      return loadedModel
    } catch (err) {
      console.warn(`[rerank] ${device} 不可用，尝试下一设备：`, String(err).slice(0, 160))
    }
  }
  return null
}

function getModel(): Promise<Loaded | null> {
  if (!modelPromise) {
    modelPromise = loadModel()
    modelPromise.catch(() => undefined)
  }
  return modelPromise
}

// 启动即预热：首次查询不必等模型加载/下载（下载完成后自动生效）
export function warmRerank(): void {
  if (rerankEnabled()) void getModel()
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

// 对候选逐对打分，返回 id → 相关性分数（0-1）；模型不可用/超时返回 null（调用方按原序兜底）
export async function rerankChunks(query: string, cands: Array<{ id: number; text: string }>): Promise<Map<number, number> | null> {
  if (!cands.length) return null
  let loaded: Loaded | null
  try {
    loaded = await Promise.race([
      getModel(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SCORE_WAIT_MS))
    ])
  } catch (err) {
    console.warn('[rerank] 模型加载失败：', String(err).slice(0, 200))
    return null
  }
  if (!loaded) return null
  const t0 = Date.now()
  try {
    const scores = new Map<number, number>()
    for (const c of cands) {
      // 逐对编码：transformers.js 的 tokenizer 批量形态不支持 text_pair 数组，逐对最稳
      const inputs = await loaded.tokenizer(query, {
        text_pair: c.text.slice(0, MAX_DOC_CHARS),
        padding: true,
        truncation: true,
        max_length: 512
      })
      const out = await loaded.model(inputs)
      scores.set(c.id, sigmoid((out.logits.data as Float32Array)[0] ?? 0))
    }
    console.log(`[rerank] ${cands.length} 候选 · ${deviceLabel(loaded.device)} · ${Date.now() - t0}ms`)
    return scores
  } catch (err) {
    console.warn('[rerank] 推理失败：', String(err).slice(0, 200))
    return null
  }
}

// 设置页「测试」：返回实际设备与一对样例的区分度（首次触发模型下载）
export async function testRerank(): Promise<{ ok: boolean; device?: string; scores?: number[]; error?: string }> {
  if (!rerankEnabled()) return { ok: false, error: '重排序已关闭' }
  try {
    const loaded = await getModel()
    if (!loaded) return { ok: false, error: '模型加载失败（查看主进程日志）' }
    const r = await rerankChunks('power module thermal resistance', [
      {
        id: 1,
        text: 'The junction temperature of the IGBT power module is estimated using thermal sensitive electrical parameters (TSEPs), and the transient thermal impedance curve is measured under different cooling conditions.'
      },
      {
        id: 2,
        text: 'The dataset contains 74 papers on deep learning methods for image classification, including convolutional neural networks and vision transformers trained on ImageNet.'
      }
    ])
    if (!r) return { ok: false, error: '推理失败（查看主进程日志）' }
    return { ok: true, device: deviceLabel(loaded.device), scores: [r.get(1) ?? 0, r.get(2) ?? 0] }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) }
  }
}
