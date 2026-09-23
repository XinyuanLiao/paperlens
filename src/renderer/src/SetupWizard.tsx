import { useState } from 'react'
import type { Settings } from './types'

const PRESETS: Array<{ id: string; label: string; base: string; model: string }> = [
  { id: 'mimo', label: '小米 MiMo', base: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' },
  { id: 'zhipu', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air' },
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', label: '通义千问 Qwen', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', label: 'Kimi 月之暗面', base: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'custom', label: '自定义 / 其他兼容服务', base: '', model: '' }
]

const STEPS = ['文献库', 'LLM 配置', '嵌入模型']

interface Props {
  initial: Settings
  onDone: () => void
}

export default function SetupWizard({ initial, onDone }: Props): JSX.Element {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<Settings>(initial)
  const [libMsg, setLibMsg] = useState('')
  const [llmTest, setLlmTest] = useState('')
  const [embedTest, setEmbedTest] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<Settings>): void => setForm((f) => ({ ...f, ...patch }))

  const pickLibrary = async (): Promise<void> => {
    const p = await window.api.pickLibrary()
    if (!p) return
    setBusy(true)
    setLibMsg('扫描中…')
    const s = await window.api.saveSettings({ libraryPath: p })
    set({ libraryPath: s.libraryPath })
    const r = await window.api.scanLibrary(s.libraryPath)
    setLibMsg(`已选择：${p.split(/[\\/]+/).pop()}（发现 ${r.total} 篇文献）`)
    setBusy(false)
  }

  const useDefault = async (): Promise<void> => {
    setBusy(true)
    setLibMsg('使用默认文献库（文档/PaperLens）…')
    const s = await window.api.saveSettings({})
    await window.api.scanLibrary(s.libraryPath)
    set({ libraryPath: s.libraryPath })
    setLibMsg(`默认文献库：${s.libraryPath}（可稍后导入 PDF 或在设置中更换）`)
    setBusy(false)
  }

  const testLlm = async (): Promise<void> => {
    setLlmTest('测试中…')
    await window.api.saveSettings(form)
    // 用界面当前值直测：不依赖已保存配置，填对即通过
    const r = await window.api.testLLM({ provider: form.provider, apiBase: form.apiBase, apiKey: form.apiKey, model: form.model })
    setLlmTest(r.ok ? `✓ 连接成功：${r.model}（${r.latencyMs}ms）` : `✗ ${r.error ?? '连接失败'}`)
  }

  const testEmbed = async (): Promise<void> => {
    setEmbedTest('测试中…')
    await window.api.saveSettings(form)
    const r = await window.api.testEmbed()
    setEmbedTest(r.ok ? `✓ 嵌入正常，向量维度 ${r.dim}` : `✗ ${r.error ?? '失败'}`)
  }

  const finish = async (): Promise<void> => {
    setBusy(true)
    await window.api.saveSettings({ ...form, setupDone: true })
    onDone()
  }

  const canNext = step === 0 ? !!form.libraryPath : true

  return (
    <div className="wizard-mask">
      <div className="wizard">
        <div className="wizard-head">
          <div className="wizard-logo">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 6c-1.8-1.6-4.2-2-8-2v14c3.8 0 6.2.4 8 2 1.8-1.6 4.2-2 8-2V4c-3.8 0-6.2.4-8 2z" />
              <path d="M12 6v14" />
            </svg>
          </div>
          <div>
            <h1>欢迎使用 PaperLens</h1>
            <p>三步完成初始化</p>
          </div>
        </div>
        <div className="wizard-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`wizard-step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`}>
              <span className="ws-num">{i < step ? '✓' : i + 1}</span>
              {s}
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {step === 0 && (
            <>
              <div className="wizard-actions">
                <button className="btn" onClick={() => void pickLibrary()} disabled={busy}>
                  选择文献库文件夹…
                </button>
                <button className="btn ghost" onClick={() => void useDefault()} disabled={busy}>
                  使用默认位置
                </button>
              </div>
              {libMsg && <div className="wizard-msg">{libMsg}</div>}
            </>
          )}

          {step === 1 && (
            <>
              <div className="preset-row">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`preset-chip ${form.provider === p.id ? 'on' : ''}`}
                    onClick={() => set(p.id === 'custom' ? { provider: p.id } : { provider: p.id, apiBase: p.base, model: p.model })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="field-row">
                <div className="field">
                  <label>API Base</label>
                  <input value={form.apiBase} onChange={(e) => set({ apiBase: e.target.value })} placeholder="https://…" />
                </div>
                <div className="field">
                  <label>模型</label>
                  <input value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="模型名" />
                </div>
              </div>
              <div className="field">
                <label>API Key</label>
                <input type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder="sk-…" />
              </div>
              <div className="wizard-actions">
                <button className="btn ghost" onClick={() => void testLlm()}>
                  测试连接
                </button>
                {llmTest && <span className="test-result">{llmTest}</span>}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="preset-row">
                <button className={`preset-chip ${form.embedProvider === 'local' ? 'on' : ''}`} onClick={() => set({ embedProvider: 'local' })}>
                  本地 e5-small
                </button>
                <button className={`preset-chip ${form.embedProvider === 'zhipu' ? 'on' : ''}`} onClick={() => set({ embedProvider: 'zhipu' })}>
                  智谱 embedding-3
                </button>
                <button className={`preset-chip ${form.embedProvider === 'ollama' ? 'on' : ''}`} onClick={() => set({ embedProvider: 'ollama' })}>
                  Ollama
                </button>
              </div>
              {form.embedProvider === 'ollama' && (
                <div className="field-row">
                  <div className="field">
                    <label>Ollama 地址</label>
                    <input value={form.ollamaUrl} onChange={(e) => set({ ollamaUrl: e.target.value })} placeholder="http://127.0.0.1:11434" />
                  </div>
                  <div className="field">
                    <label>嵌入模型</label>
                    <input value={form.ollamaEmbedModel} onChange={(e) => set({ ollamaEmbedModel: e.target.value })} placeholder="bge-m3" />
                  </div>
                </div>
              )}
              <div className="wizard-actions">
                <button className="btn ghost" onClick={() => void testEmbed()}>
                  测试嵌入
                </button>
                {embedTest && <span className="test-result">{embedTest}</span>}
              </div>
            </>
          )}
        </div>

        <div className="wizard-foot">
          <span className="wizard-skip" onClick={() => void finish()}>
            跳过，直接进入
          </span>
          <span style={{ flex: 1 }} />
          {step > 0 && (
            <button className="btn ghost" onClick={() => setStep((s) => s - 1)}>
              上一步
            </button>
          )}
          {step < 2 ? (
            <button className="btn" onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
              下一步
            </button>
          ) : (
            <button className="btn" onClick={() => void finish()} disabled={busy}>
              完成设置
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
