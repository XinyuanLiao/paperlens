import { useEffect, useState } from 'react'
import type { Settings } from './types'

interface Props {
  settings: Settings
  indexed: { papers: number; indexed: number; chunks: number }
  indexInfo: { done: number; total: number; phase: string } | null
  onSave: (patch: Partial<Settings>) => Promise<Settings>
  onRescanned: () => void
  onClose: () => void
}

const PRESETS: Array<{ id: string; label: string; base: string; model: string }> = [
  { id: 'zhipu', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air' },
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', label: '通义千问 Qwen', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', label: 'Kimi 月之暗面', base: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'custom', label: '自定义 / 其他兼容服务', base: '', model: '' }
]

function guessProvider(apiBase: string): string {
  const hit = PRESETS.find((p) => p.id !== 'custom' && apiBase.startsWith(p.base))
  return hit?.id ?? 'custom'
}

function workspaceName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export default function SettingsDialog({ settings, indexed, indexInfo, onSave, onRescanned, onClose }: Props): JSX.Element {
  const [form, setForm] = useState<Settings>(settings)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [llmTest, setLlmTest] = useState('')
  const [embedTest, setEmbedTest] = useState('')

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const set = (patch: Partial<Settings>): void => setForm((f) => ({ ...f, ...patch }))

  // 主题即点即换（保存立即生效，无预览对话框状态残留）
  const pickTheme = async (theme: Settings['theme']): Promise<void> => {
    set({ theme })
    await onSave({ theme })
  }

  const pickPreset = (id: string): void => {
    const p = PRESETS.find((x) => x.id === id)!
    set(id === 'custom' ? { provider: id } : { provider: id, apiBase: p.base, model: p.model })
  }

  const pickWorkspace = async (): Promise<void> => {
    const p = await window.api.pickLibrary()
    if (!p) return
    setBusy(true)
    setMsg('切换工作区并扫描…')
    const s = await onSave({ libraryPath: p })
    const r = await window.api.scanLibrary(s.libraryPath)
    setMsg(`工作区：${workspaceName(p)}（${r.total} 篇）`)
    onRescanned()
    setBusy(false)
  }

  const testLlm = async (): Promise<void> => {
    setLlmTest('测试中…')
    await onSave(form) // 测试用已保存配置
    const r = await window.api.testLLM()
    if (r.ok) {
      const bal = r.balance ? `，余额 ${r.balance.currency === 'CNY' ? '¥' : r.balance.currency + ' '}${r.balance.amount}` : ''
      const q = r.quota ? `，${r.quota}` : ''
      setLlmTest(`✓ 连接成功：${r.model}（${r.latencyMs}ms）${bal}${q}`)
    } else {
      setLlmTest(`✗ ${r.error ?? '连接失败'}`)
    }
  }

  const testEmbed = async (): Promise<void> => {
    setEmbedTest('测试中…')
    await onSave(form)
    const r = await window.api.testEmbed()
    setEmbedTest(r.ok ? `✓ 嵌入正常，向量维度 ${r.dim}` : `✗ ${r.error ?? '失败'}`)
  }

  const rebuild = async (): Promise<void> => {
    setBusy(true)
    await onSave(form)
    await window.api.rebuildIndex()
    setMsg('已清空索引并开始重建，可关闭本窗口')
    setBusy(false)
  }

  const save = async (): Promise<void> => {
    await onSave(form)
    onClose()
  }

  const themeCard = (id: Settings['theme'], label: string, preview: JSX.Element): JSX.Element => (
    <div className={`theme-card ${form.theme === id ? 'on' : ''}`} onClick={() => void pickTheme(id)}>
      <div className="theme-thumb">{preview}</div>
      <div className="theme-label">{label}</div>
    </div>
  )

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <button className="modal-x" title="关闭（不保存）" onClick={onClose}>
          ✕
        </button>
        <h2>设置</h2>

        <div className="section">
          <div className="section-title">外观</div>
          <div className="theme-row">
            {themeCard(
              'system',
              '跟随系统',
              <div className="tt tt-split">
                <div className="tt-side" />
                <div className="tt-main" />
              </div>
            )}
            {themeCard(
              'light',
              '浅色',
              <div className="tt tt-light">
                <div className="tt-side" />
                <div className="tt-main" />
              </div>
            )}
            {themeCard(
              'dark',
              '深色',
              <div className="tt tt-dark">
                <div className="tt-side" />
                <div className="tt-main" />
              </div>
            )}
          </div>
          <div className="field-row" style={{ marginTop: 10 }}>
            <div className="field grow">
              <label>翻译目标语言</label>
              <input value={form.translateTarget} onChange={(e) => set({ translateTarget: e.target.value })} />
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-title">工作区</div>
          <div className="ws-row">
            <div className="ws-icon">📁</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ws-name">{workspaceName(form.libraryPath)}</div>
              <div className="hint">论文的存储结构由应用自动管理，无需关心内部文件。导入、归类、索引全自动。</div>
            </div>
            <button className="btn ghost" onClick={pickWorkspace} disabled={busy}>
              更改…
            </button>
          </div>
        </div>

        <div className="section">
          <div className="section-title">AI 服务</div>
          <div className="field">
            <label>服务商（内置 OpenAI 兼容地址，可切换后手动微调）</label>
            <select value={form.provider === 'custom' ? 'custom' : guessProvider(form.apiBase)} onChange={(e) => pickPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>API Base</label>
            <input value={form.apiBase} onChange={(e) => set({ apiBase: e.target.value, provider: guessProvider(e.target.value) })} />
          </div>
          <div className="field-row">
            <div className="field grow">
              <label>API Key</label>
              <input type="password" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder="粘贴 API Key" />
            </div>
            <div className="field grow">
              <label>模型</label>
              <input value={form.model} onChange={(e) => set({ model: e.target.value })} />
            </div>
          </div>
          <div className="test-row">
            <button className="btn ghost" onClick={() => void testLlm()} disabled={busy}>
              测试连接
            </button>
            <span className="test-result">{llmTest}</span>
          </div>
        </div>

        <div className="section">
          <div className="section-title">向量嵌入（切换后需重建索引）</div>
          <div className="field-row">
            <div className="field grow">
              <label>嵌入来源</label>
              <select value={form.embedProvider} onChange={(e) => set({ embedProvider: e.target.value as Settings['embedProvider'] })}>
                <option value="local">本地 e5-small（离线免费，首次下载约 130MB）</option>
                <option value="ollama">Ollama 本地模型（bge-m3 等，效果更好）</option>
                <option value="zhipu">智谱 embedding-3（云端，按量计费）</option>
              </select>
            </div>
            {form.embedProvider === 'ollama' && (
              <div className="field grow">
                <label>Ollama 模型</label>
                <input value={form.ollamaEmbedModel} onChange={(e) => set({ ollamaEmbedModel: e.target.value })} placeholder="bge-m3" />
              </div>
            )}
          </div>
          {form.embedProvider === 'ollama' && (
            <div className="field">
              <label>Ollama 服务地址</label>
              <input value={form.ollamaUrl} onChange={(e) => set({ ollamaUrl: e.target.value })} placeholder="http://127.0.0.1:11434" />
              <div className="hint">需先安装并运行 Ollama，且 ollama pull 对应嵌入模型。</div>
            </div>
          )}
          <div className="test-row">
            <button className="btn ghost" onClick={() => void testEmbed()} disabled={busy}>
              测试嵌入
            </button>
            <span className="test-result">{embedTest}</span>
          </div>
        </div>

        <div className="section">
          <div className="section-title">索引</div>
          <div className="hint" style={{ marginTop: 0 }}>
            已索引 {indexed.indexed}/{indexed.papers} 篇 · {indexed.chunks} 个文本块
            {indexInfo ? ` · 正在处理 ${indexInfo.current ?? ''} (${indexInfo.done}/${indexInfo.total})` : ''}
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={rebuild} disabled={busy}>
              重建全库索引
            </button>
          </div>
        </div>

        <div className="modal-actions">
          <span className="progress-line" style={{ flex: 1 }}>
            {msg}
          </span>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
