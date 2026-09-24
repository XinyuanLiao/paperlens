// PDF 结构化解析：liteparse（Rust/napi 进程内，run-llama/liteparse）。
// 纯文本层无 OCR（学术 PDF 均有文本层），实测 ~80ms/11 页；输出逐页 markdown（标题层级/表格），
// 供结构化分块识别章节。解析失败返回 null，调用方回退内置 pdfjs 分块。

import * as LP from '@llamaindex/liteparse'

interface ParsedPages {
  pages: Array<{ pageNum: number; markdown?: string }>
}

interface LiteparseInstance {
  parse(path: string): Promise<ParsedPages>
}

type LiteparseCtor = new (cfg?: Record<string, unknown>) => LiteparseInstance

// CJS 包经打包器的默认导出会包多层 default，循环解开直到拿到构造器
function unwrapCtor(): LiteparseCtor {
  let x: unknown = LP
  for (let i = 0; i < 4 && x && typeof x !== 'function'; i++) {
    x = (x as { default?: unknown }).default
  }
  if (typeof x !== 'function') {
    throw new Error(`LiteParse 导出形状异常：${Object.keys((LP ?? {}) as object).join(',').slice(0, 120)}`)
  }
  return x as LiteparseCtor
}

let engine: LiteparseInstance | null = null

function getEngine(): LiteparseInstance {
  if (!engine) {
    const Ctor = unwrapCtor()
    engine = new Ctor({ ocrEnabled: false, imageMode: 'off', outputFormat: 'markdown' })
  }
  return engine
}

export async function runLiteparse(pdfPath: string): Promise<Array<{ page: number; md: string }> | null> {
  try {
    const res = await getEngine().parse(pdfPath)
    const pages: Array<{ page: number; md: string }> = []
    for (const p of res.pages) {
      const md = (p.markdown ?? '').trim()
      if (md) pages.push({ page: p.pageNum, md })
    }
    return pages.length ? pages : null
  } catch (err) {
    console.warn('[liteparse] 解析失败，回退内置分块：', String(err).slice(0, 160))
    return null
  }
}
