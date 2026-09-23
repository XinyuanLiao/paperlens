import { useEffect, useRef, useState } from 'react'
import type { Settings } from './types'

interface Props {
  settings: Settings
  indexed: { papers: number; indexed: number; chunks: number }
  indexInfo: { done: number; total: number; phase: string; current?: string } | null
  onSave: (patch: Partial<Settings>) => Promise<Settings>
  onRescanned: () => void
  onClose: () => void
  // 对话字号（通用页调节，App 全局生效）
  chatFs: number
  onChatFs: (delta: number) => void
  onChatFsReset: () => void
}

const PRESETS: Array<{ id: string; label: string; base: string; model: string }> = [
  { id: 'zhipu', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air' },
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', label: '通义千问 Qwen', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', label: 'Kimi 月之暗面', base: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'custom', label: '自定义 / 其他兼容服务', base: '', model: '' }
]

const LANGS = ['中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский', 'Português', 'Italiano']

const THINK_LEVELS: Array<{ id: Settings['thinkingLevel']; label: string }> = [
  { id: 'default', label: '默认（跟随模型）' },
  { id: 'off', label: '关闭' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' }
]

type TabId = 'general' | 'ai' | 'kb' | 'update'
const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'general', label: '通用', icon: '⚙' },
  { id: 'ai', label: 'AI 配置', icon: '✦' },
  { id: 'kb', label: '知识库', icon: '▣' },
  { id: 'update', label: '更新', icon: '↑' }
]

function guessProvider(apiBase: string): string {
  const hit = PRESETS.find((p) => p.id !== 'custom' && apiBase.startsWith(p.base))
  return hit?.id ?? 'custom'
}

const providerLabel = (id: string): string => PRESETS.find((p) => p.id === id)?.label ?? id

function workspaceName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

// 语义化版本比较：a<b 返回 -1，a>b 返回 1，相等 0
function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

export default function SettingsDialog({
  settings,
  indexed,
  indexInfo,
  onSave,
  onRescanned,
  onClose,
  chatFs,
  onChatFs,
  onChatFsReset
}: Props): JSX.Element {
  const [tab, setTab] = useState<TabId>('general')
  const [form, setForm] = useState<Settings>(settings)
  const [profiles, setProfiles] = useState<NonNullable<Settings['profiles']>>(
    () =>
      settings.profiles?.length
        ? settings.profiles
        : [
            {
              provider: settings.provider,
              apiBase: settings.apiBase,
              apiKey: settings.apiKey,
              models: settings.models?.length ? settings.models : settings.model ? [settings.model] : []
            }
          ]
  )
  // 服务商卡片默认只展开「使用中」的那张，其余收起
  const [openProfiles, setOpenProfiles] = useState<Set<number>>(() => {
    const s = new Set<number>()
    const first = (settings.profiles?.length ? settings.profiles : [settings]).findIndex((p) => p.models?.includes(settings.model))
    s.add(first >= 0 ? first : 0)
    return s
  })
  const [llmTests, setLlmTests] = useState<Record<number, string>>({})
  const [embedTest, setEmbedTest] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  // 本地字体列表（设置打开时枚举一次）
  const [fonts, setFonts] = useState<string[]>([])
  useEffect(() => {
    void window.api.listFonts().then(setFonts).catch(() => {})
  }, [])
  const profileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveProfiles = (list: NonNullable<Settings['profiles']>): void => {
    if (profileSaveTimer.current) clearTimeout(profileSaveTimer.current)
    profileSaveTimer.current = setTimeout(() => {
      void onSave({ profiles: list })
    }, 300)
  }

  // 更新页状态
  const [curVer, setCurVer] = useState('')
  const [updBusy, setUpdBusy] = useState(false)
  const [updInfo, setUpdInfo] = useState<{ ok: boolean; latest?: string; url?: string; notes?: string; published?: string; error?: string } | null>(null)
  useEffect(() => {
    void window.api.appVersion().then(setCurVer)
  }, [])

  // Esc 监听只注册一次，但必须拿到最新表单：用 ref 中转，避免 stale closure 把旧值写回去
  const saveRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void saveRef.current()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const set = (patch: Partial<Settings>): void => setForm((f) => ({ ...f, ...patch }))

  // 主题即点即换（保存立即生效，无预览对话框状态残留）
  const pickTheme = async (theme: Settings['theme']): Promise<void> => {
    set({ theme })
    await onSave({ theme })
  }

  // 默认模型切换：聚合所有服务商的模型，选中即激活所属服务商（与对话界面切换等效）
  const allModels = profiles.flatMap((p) => p.models.map((m) => ({ m, pf: p })))
  const switchModel = async (m: string): Promise<void> => {
    const hit = allModels.find((x) => x.m === m)
    set({ model: m, ...(hit ? { provider: hit.pf.provider, apiBase: hit.pf.apiBase, apiKey: hit.pf.apiKey, models: hit.pf.models } : {}) })
    await onSave({ model: m, ...(hit ? { provider: hit.pf.provider, apiBase: hit.pf.apiBase, apiKey: hit.pf.apiKey, models: hit.pf.models } : {}) })
  }

  const pickWorkspace = async (): Promise<void> => {
    const p = await window.api.pickLibrary()
    if (!p) return
    setBusy(true)
    setMsg('切换工作区并扫描…')
    set({ libraryPath: p }) // 同步进表单，避免点「保存」时把旧路径写回去
    const s = await onSave({ libraryPath: p })
    const r = await window.api.scanLibrary(s.libraryPath)
    setMsg(`工作区：${workspaceName(p)}（${r.total} 篇）`)
    onRescanned()
    setBusy(false)
  }

  // 直测该卡片当前编辑值（key/base 都在卡片上，不依赖已保存的全局配置）
  const testLlm = async (i: number): Promise<void> => {
    const pf = profiles[i]
    if (!pf) return
    setLlmTests((t) => ({ ...t, [i]: '测试中…' }))
    const over = {
      provider: pf.provider,
      apiBase: pf.apiBase,
      apiKey: pf.apiKey,
      model: pf.models[0] ?? form.model
    }
    await onSave(form)
    const r = await window.api.testLLM(over)
    if (r.ok) {
      const bal = r.balance ? `，余额 ${r.balance.currency === 'CNY' ? '¥' : r.balance.currency + ' '}${r.balance.amount}` : ''
      setLlmTests((t) => ({ ...t, [i]: `✓ 连接成功：${r.model}（${r.latencyMs}ms）${bal}` }))
    } else {
      setLlmTests((t) => ({ ...t, [i]: `✗ ${r.error ?? '连接失败'}` }))
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
    // 当前使用的模型属于哪个配置，就把那个供应商的信息同步为激活配置
    const active = profiles.find((p) => p.models.includes(form.model)) ?? profiles[0]
    await onSave({
      ...form,
      profiles,
      ...(active ? { provider: active.provider, apiBase: active.apiBase, apiKey: active.apiKey, models: active.models } : {})
    })
    onClose()
  }
  saveRef.current = save

  // ✕ / 点击遮罩 / Esc：一律保存后关闭
  const closeAndSave = (): void => {
    void save()
  }

  const themeCard = (id: Settings['theme'], label: string, preview: JSX.Element): JSX.Element => (
    <div className={`theme-card ${form.theme === id ? 'on' : ''}`} onClick={() => void pickTheme(id)}>
      <div className="theme-thumb">{preview}</div>
      <div className="theme-label">{label}</div>
    </div>
  )

  const checkUpdate = async (): Promise<void> => {
    setUpdBusy(true)
    setUpdInfo(null)
    try {
      const r = await window.api.checkUpdate()
      setUpdInfo(r.ok ? { ok: true, latest: r.latest, url: r.url, notes: r.notes, published: r.published } : { ok: false, error: r.error })
    } catch (err) {
      setUpdInfo({ ok: false, error: String(err).slice(0, 160) })
    }
    setUpdBusy(false)
  }

  return (
    <div className="modal-mask" onMouseDown={closeAndSave}>
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>设置 · {TABS.find((t) => t.id === tab)?.label}</h2>
          <button className="modal-x" title="关闭（自动保存）" onClick={closeAndSave}>
            ✕
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-nav">
            {TABS.map((t) => (
              <button key={t.id} className={`settings-nav-btn ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
                <span className="snav-ico">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
          <div className="settings-content">

          {tab === 'general' && (
            <>
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
              </div>
              <div className="section">
                <div className="section-title">字体</div>
                <div className="fs-setting-row">
                  <div style={{ flex: 1 }}>
                    <div className="fs-setting-name">对话字号</div>
                  <div className="hint">问答 / 翻译 / 对话三处共用，即时生效。</div>
                  </div>
                  <div className="fs-ctl big">
                    <button onClick={() => onChatFs(-1)} title="减小字号">A−</button>
                    <span className="fs-val">{chatFs}px</span>
                    <button onClick={() => onChatFs(1)} title="增大字号">A+</button>
                  </div>
                  <button className="btn ghost fs-reset" onClick={onChatFsReset}>重置</button>
                </div>
                <div className="field" style={{ marginTop: 12 }}>
                  <label>界面字体</label>
                  <select value={form.fontFamily ?? ''} onChange={(e) => set({ fontFamily: e.target.value })}>
                    <option value="">默认</option>
                    {fonts.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <div className="hint">扫描本机已安装字体，中英文统一由所选字体渲染（缺字时回退默认）；选「默认」恢复内置字体栈。</div>
                </div>
              </div>
              <div className="section">
                <div className="section-title">翻译</div>
                <div className="field">
                  <label>划词翻译目标语言</label>
                  <select value={form.translateTarget} onChange={(e) => set({ translateTarget: e.target.value })}>
                    {(LANGS.includes(form.translateTarget) ? LANGS : [form.translateTarget, ...LANGS]).map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}

          {tab === 'ai' && (
            <>
              <div className="section">
                <div className="section-title">默认模型</div>
                <div className="field">
                  <label>对话 / 翻译 / 问答使用的模型（切换后自动激活其所属服务商）</label>
                  <select value={form.model} onChange={(e) => void switchModel(e.target.value)}>
                    {allModels.length === 0 && <option value="">（先在下方填写模型）</option>}
                    {profiles.map((pf, i) =>
                      pf.models.length ? (
                        <optgroup key={i} label={providerLabel(guessProvider(pf.apiBase) === 'custom' ? pf.provider : guessProvider(pf.apiBase))}>
                          {pf.models.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </optgroup>
                      ) : null
                    )}
                    {/* 不属于任何配置的模型保持可选 */}
                    {form.model && !allModels.some((x) => x.m === form.model) && <option value={form.model}>{form.model}</option>}
                  </select>
                </div>
                <div className="field">
                  <label>思考等级</label>
                  <select value={form.thinkingLevel ?? 'default'} onChange={(e) => set({ thinkingLevel: e.target.value as Settings['thinkingLevel'] })}>
                    {THINK_LEVELS.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="section">
                <div className="section-title">服务商配置（{profiles.length} 个，点卡片头收起 / 展开）</div>
                {profiles.map((pf, i) => {
                  const isActive = pf.models.includes(form.model)
                  const isOpen = openProfiles.has(i)
                  const patchPf = (patch: Partial<{ provider: string; apiBase: string; apiKey: string; models: string[] }>): void => {
                    const next = profiles.map((x, idx) => (idx === i ? { ...x, ...patch } : x))
                    saveProfiles(next)
                    setProfiles(next)
                  }
                  return (
                    <div className={`profile-card ${isActive ? 'active' : ''} ${isOpen ? '' : 'collapsed'}`} key={i}>
                      <div
                        className="profile-head"
                        onClick={() =>
                          setOpenProfiles((s) => {
                            const n = new Set(s)
                            if (n.has(i)) n.delete(i)
                            else n.add(i)
                            return n
                          })
                        }
                      >
                        <svg className={`chev ${isOpen ? 'open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                        <span className="profile-name">{providerLabel(pf.provider === 'custom' ? 'custom' : guessProvider(pf.apiBase))}</span>
                        <span className="profile-meta ellipsis">{pf.apiBase.replace(/^https?:\/\//, '') || '未配置地址'}</span>
                        {pf.models.length > 0 && <span className="profile-models-chip">{pf.models.length} 模型</span>}
                        {isActive ? <span className="active-tag">使用中</span> : null}
                      </div>
                      <div className="profile-body">
                        <div className="field-row">
                          <div className="field">
                            <label>服务商</label>
                            <select
                              value={pf.provider === 'custom' ? 'custom' : guessProvider(pf.apiBase)}
                              onChange={(e) => {
                                const preset = PRESETS.find((x) => x.id === e.target.value)!
                                patchPf(preset.id === 'custom' ? { provider: 'custom' } : { provider: preset.id, apiBase: preset.base })
                              }}
                            >
                              {PRESETS.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="field grow">
                            <label>API Base</label>
                            <input value={pf.apiBase} onChange={(e) => patchPf({ apiBase: e.target.value })} />
                          </div>
                        </div>
                        <div className="field">
                          <label>API Key</label>
                          <input type="password" value={pf.apiKey} onChange={(e) => patchPf({ apiKey: e.target.value })} placeholder="sk-…" />
                        </div>
                        <div className="field">
                          <label>模型（逗号分隔）</label>
                          <input
                            value={pf.models.join(', ')}
                            onChange={(e) =>
                              patchPf({
                                models: e.target.value
                                  .split(/[,，]/)
                                  .map((s) => s.trim())
                                  .filter(Boolean)
                              })
                            }
                            placeholder="deepseek-chat, deepseek-reasoner"
                          />
                        </div>
                        <div className="profile-foot">
                          {isActive ? (
                            <span className="active-tag">当前默认</span>
                          ) : (
                            <span
                              className="profile-link"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (pf.models[0]) void switchModel(pf.models[0])
                              }}
                            >
                              {pf.models[0] ? '设为默认' : '填写模型后可用'}
                            </span>
                          )}
                          <span style={{ flex: 1 }} />
                          {profiles.length > 1 && (
                            <button
                              className="profile-del"
                              onClick={(e) => {
                                e.stopPropagation()
                                const next = profiles.filter((_, idx) => idx !== i)
                                saveProfiles(next)
                                setProfiles(next)
                                // 展开状态按原索引平移（大于 i 的减一），避免删后错位
                                setOpenProfiles((s) => {
                                  const n = new Set<number>()
                                  for (const x of s) {
                                    if (x < i) n.add(x)
                                    else if (x > i) n.add(x - 1)
                                  }
                                  return n
                                })
                              }}
                            >
                              删除
                            </button>
                          )}
                        </div>
                        <div className="test-row">
                          <button className="btn ghost" onClick={() => void testLlm(i)} disabled={busy}>
                            测试连接
                          </button>
                          <span className="test-result">{llmTests[i] ?? ''}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
                <button
                  className="profile-add"
                  onClick={() => {
                    const next = [...profiles, { provider: 'zhipu', apiBase: PRESETS[0].base, apiKey: '', models: [] }]
                    saveProfiles(next)
                    setProfiles(next)
                    setOpenProfiles((s) => new Set([...s, next.length - 1]))
                  }}
                >
                  + 添加服务商配置
                </button>
              </div>
            </>
          )}

          {tab === 'kb' && (
            <>
              <div className="section">
                <div className="section-title">工作区</div>
                <div className="ws-row">
                  <div className="ws-icon">📁</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ws-name">{workspaceName(form.libraryPath)}</div>
                    <div className="hint ellipsis" title={form.libraryPath}>{form.libraryPath}</div>
                  </div>
                  <button className="btn ghost" onClick={pickWorkspace} disabled={busy}>
                    更改…
                  </button>
                </div>
              </div>

              <div className="section">
                <div className="section-title">向量嵌入（检索用）</div>
                <div className="field-row">
                  <div className="field grow">
                    <label>嵌入来源</label>
                    <select value={form.embedProvider} onChange={(e) => set({ embedProvider: e.target.value as Settings['embedProvider'] })}>
                      <option value="local">本地 e5-small</option>
                      <option value="ollama">Ollama</option>
                      <option value="zhipu">智谱 embedding-3</option>
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
            </>
          )}

          {tab === 'update' && (
            <>
              <div className="section">
                <div className="section-title">版本</div>
                <div className="ver-row">
                  <div>
                    <div className="ws-name">PaperLens {curVer || '…'}</div>
                    <div className="hint">通过 GitHub Releases 发布更新。</div>
                  </div>
                  <span style={{ flex: 1 }} />
                  <button className="btn" onClick={() => void checkUpdate()} disabled={updBusy}>
                    {updBusy ? '检查中…' : '检查更新'}
                  </button>
                </div>
                {updInfo?.ok && (
                  <div className={`upd-box ${cmpVer(curVer, updInfo.latest!) < 0 ? 'has-new' : ''}`}>
                    {cmpVer(curVer, updInfo.latest!) < 0 ? (
                      <>
                        <div className="upd-line">
                          发现新版本 <b>v{updInfo.latest}</b>（当前 v{curVer}）
                          {updInfo.published ? <span className="upd-date"> · {updInfo.published.slice(0, 10)}</span> : null}
                        </div>
                        {updInfo.notes && <pre className="upd-notes">{updInfo.notes}</pre>}
                        <button className="btn" onClick={() => window.api.openExternal(updInfo.url!)}>
                          前往 GitHub 下载
                        </button>
                      </>
                    ) : (
                      <div className="upd-line">✓ 已是最新版本（v{curVer}）</div>
                    )}
                  </div>
                )}
                {updInfo && !updInfo.ok && (
                  <div className="upd-box">
                    <div className="upd-line err">检查失败：{updInfo.error}</div>
                    <button className="btn ghost" onClick={() => window.api.openExternal('https://github.com/XinyuanLiao/paperlens/releases')}>
                      打开 Releases 页面
                    </button>
                  </div>
                )}
              </div>
              <div className="section">
                <div className="section-title">链接</div>
                <div className="link-row" onClick={() => window.api.openExternal('https://github.com/XinyuanLiao/paperlens')}>
                  <span className="ws-icon">🐙</span>
                  <div style={{ flex: 1 }}>
                    <div className="ws-name">GitHub 仓库</div>
                    <div className="hint">XinyuanLiao/paperlens · 源码与 Issue 反馈</div>
                  </div>
                  <span className="link-arrow">↗</span>
                </div>
              </div>
            </>
          )}

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
