import { useEffect, useRef, useState } from 'react'
import type { Settings } from './types'
// 服务商预设只有一份（与首次启动向导、主进程请求体适配共用），不在各处各抄一张表——
// 曾经两张表各存一份，Kimi 的默认模型在两边都是早已下线的名字
import { PRESETS, guessPreset } from '../../shared/providers'

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

const LANGS = ['中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский', 'Português', 'Italiano']

type TabId = 'general' | 'ai' | 'kb' | 'update'
const TABS: Array<{ id: TabId; label: string; icon: JSX.Element }> = [
  {
    id: 'general',
    label: '通用',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h16" />
        <circle cx="15.5" cy="6" r="1.8" />
        <circle cx="9.5" cy="12" r="1.8" />
        <circle cx="18" cy="18" r="1.8" />
      </svg>
    )
  },
  {
    id: 'ai',
    label: 'AI 配置',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" />
        <path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3z" />
      </svg>
    )
  },
  {
    id: 'kb',
    label: '知识库',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
        <path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
        <path d="M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
      </svg>
    )
  },
  {
    id: 'update',
    label: '更新',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16V8M8.5 11.5L12 8l3.5 3.5" />
      </svg>
    )
  }
]

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
  const [rerankTest, setRerankTest] = useState('')
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
  // 卡片对应的预设：API Base 命中已知服务商就以它为准（与主进程的参数适配同一判定），否则看记下的服务商
  const presetOf = (pf: { provider: string; apiBase: string }) => guessPreset(pf.apiBase) ?? PRESETS.find((p) => p.id === pf.provider) ?? PRESETS[PRESETS.length - 1]
  // 当前默认模型所属的服务商配置（与 save() 的同步逻辑一致），翻译引擎的 LLM 选项按它有无 Key 决定
  const activePf = profiles.find((p) => p.models.includes(form.model)) ?? profiles[0]
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
    // 测该卡片的默认模型：正被设为全局默认的那个，否则列表首个
    const over = {
      provider: pf.provider,
      apiBase: pf.apiBase,
      apiKey: pf.apiKey,
      model: pf.models.includes(form.model) ? form.model : pf.models[0] ?? form.model
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

  // 向服务商拉取现役模型列表，替换该卡片的模型列表。预设里的模型名会随服务商迭代过期
  //（Kimi 的 kimi-k2-0711-preview 等已整批下线），以服务商实时返回的为准
  const syncModels = async (i: number): Promise<void> => {
    const pf = profiles[i]
    if (!pf) return
    setLlmTests((t) => ({ ...t, [i]: '同步模型中…' }))
    const r = await window.api.listModels({ apiBase: pf.apiBase, apiKey: pf.apiKey, provider: pf.provider })
    if (!r.ok) {
      setLlmTests((t) => ({ ...t, [i]: `✗ ${r.error}` }))
      return
    }
    const next = profiles.map((x, idx) => (idx === i ? { ...x, models: r.models } : x))
    saveProfiles(next)
    setProfiles(next)
    // 当前默认模型原本属于这张卡片、却不在新列表里（已下线）：换到该服务商的预设默认，再不行取列表首项
    if (!r.models.includes(form.model) && pf.models.includes(form.model)) {
      const preset = guessPreset(pf.apiBase)
      const m = preset && r.models.includes(preset.model) ? preset.model : r.models[0]
      set({ model: m })
      await onSave({ model: m, provider: pf.provider, apiBase: pf.apiBase, apiKey: pf.apiKey, models: r.models })
    }
    setLlmTests((t) => ({ ...t, [i]: `✓ 已同步 ${r.models.length} 个模型` }))
  }

  const testEmbed = async (): Promise<void> => {
    setEmbedTest('测试中…')
    await onSave(form)
    const r = await window.api.testEmbed()
    setEmbedTest(r.ok ? `✓ ${r.dim} 维` : `✗ ${r.error ?? '失败'}`)
  }

  const testRerankModel = async (): Promise<void> => {
    setRerankTest('测试中…')
    await onSave(form)
    const r = await window.api.testRerank()
    if (r.ok) {
      const [rel, irr] = r.scores ?? []
      setRerankTest(`✓ 相关 ${rel?.toFixed(3)} / 无关 ${irr?.toFixed(3)}`)
    } else {
      setRerankTest(`✗ ${r.error ?? '失败'}`)
    }
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
                <div className="field">
                  <label>翻译引擎</label>
                  <select
                    value={activePf?.apiKey ? (form.translateEngine ?? 'llm') : 'google'}
                    onChange={(e) => set({ translateEngine: e.target.value as Settings['translateEngine'] })}
                  >
                    {activePf?.apiKey && <option value="llm">LLM · {form.model || '当前默认模型'}（术语更准，走 AI 配置）</option>}
                    <option value="google">谷歌翻译（免费，无需配置）</option>
                    <option value="bing">必应翻译（免费，无需配置）</option>
                  </select>
                  <div className="hint">
                    {activePf?.apiKey
                      ? 'LLM 引擎使用「AI 配置」里的当前默认模型；免费引擎即开即用，失败时自动切换另一家。'
                      : '未配置 AI 服务商（或当前服务商没有 API Key）时仅可用免费翻译引擎；配置后可用 LLM 翻译。'}
                  </div>
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
                        <optgroup key={i} label={presetOf(pf).label}>
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
                  const preset = presetOf(pf)
                  const suggestions = preset.models
                  // 添加模型：支持逗号/换行批量粘贴，去重
                  const addModels = (raw: string): void => {
                    const names = raw
                      .split(/[,，\n]/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                    const merged = [...pf.models]
                    for (const n of names) if (!merged.includes(n)) merged.push(n)
                    if (merged.length !== pf.models.length) patchPf({ models: merged })
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
                        <span className="profile-name">{preset.label}</span>
                        <span className="profile-meta ellipsis">{pf.apiBase.replace(/^https?:\/\//, '') || '未配置地址'}</span>
                        {pf.models.length > 0 && <span className="profile-models-chip">{pf.models.length} 模型</span>}
                        {isActive ? <span className="active-tag">使用中</span> : null}
                      </div>
                      <div className="profile-body">
                        <div className="field-row">
                          <div className="field">
                            <label>服务商</label>
                            <select
                              value={preset.id}
                              onChange={(e) => {
                                const next = PRESETS.find((x) => x.id === e.target.value) ?? PRESETS[PRESETS.length - 1]
                                if (next.id === 'custom') {
                                  patchPf({ provider: 'custom' })
                                  return
                                }
                                // 切服务商 = 换了一家的接口：旧模型名在新服务商那里并不存在，整份换成新家的模型
                                //（以前只换地址不换模型，带着上一家的模型名去测，必然报「模型不存在」）
                                patchPf({ provider: next.id, apiBase: next.base, models: [...next.models] })
                                // 当前默认模型出自这张卡片：跟着切到新家的默认模型，并同步激活配置
                                if (pf.models.includes(form.model)) {
                                  set({ model: next.model })
                                  void onSave({ model: next.model, provider: next.id, apiBase: next.base, apiKey: pf.apiKey, models: next.models })
                                }
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
                            <input value={pf.apiBase} onChange={(e) => patchPf({ apiBase: e.target.value })} spellCheck={false} />
                          </div>
                        </div>
                        <div className="field">
                          <label>
                            API Key
                            {preset.keyUrl && (
                              <span className="field-link" title={preset.keyUrl} onClick={() => window.api.openExternal(preset.keyUrl!)}>
                                获取 Key ↗
                              </span>
                            )}
                          </label>
                          <input
                            type="password"
                            value={pf.apiKey}
                            onChange={(e) => patchPf({ apiKey: e.target.value })}
                            onBlur={(e) => {
                              // 粘贴的 Key 常带首尾空白：失焦时清掉
                              const v = e.currentTarget.value.trim()
                              if (v !== e.currentTarget.value) patchPf({ apiKey: v })
                            }}
                            placeholder="sk-…"
                            spellCheck={false}
                            autoComplete="off"
                          />
                          {preset.note && <div className="hint">{preset.note}</div>}
                        </div>
                        <div className="field">
                          <label>模型（可添加多个）</label>
                          <div className="model-chips">
                            {pf.models.map((m, mi) => (
                              <span
                                className={`model-chip ${m === form.model ? 'on' : ''}`}
                                key={`${m}-${mi}`}
                                title={m === form.model ? '当前默认模型' : '点击设为默认模型'}
                                onClick={() => void switchModel(m)}
                              >
                                <span className="mc-name">{m}</span>
                                {m === form.model && <span className="mc-default">默认</span>}
                                <button
                                  type="button"
                                  title="移除该模型"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    patchPf({ models: pf.models.filter((_, x) => x !== mi) })
                                  }}
                                >
                                  ✕
                                </button>
                              </span>
                            ))}
                            <input
                              className="model-add"
                              list={`model-sug-${i}`}
                              placeholder={pf.models.length ? '添加模型，回车确认…' : '输入模型名，回车添加'}
                              onKeyDown={(e) => {
                                const el = e.currentTarget
                                if (e.key === 'Enter' || e.key === ',') {
                                  e.preventDefault()
                                  addModels(el.value)
                                  el.value = ''
                                } else if (e.key === 'Backspace' && !el.value && pf.models.length) {
                                  patchPf({ models: pf.models.slice(0, -1) })
                                }
                              }}
                              onBlur={(e) => {
                                if (e.target.value.trim()) {
                                  addModels(e.target.value)
                                  e.target.value = ''
                                }
                              }}
                            />
                            <datalist id={`model-sug-${i}`}>
                              {suggestions
                                .filter((s) => !pf.models.includes(s))
                                .map((s) => (
                                  <option key={s} value={s} />
                                ))}
                            </datalist>
                          </div>
                          <div className="hint">同一服务商可挂多个模型，输入框有常用模型建议；逗号/换行批量粘贴也可以。</div>
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
                          <button
                            className="btn ghost"
                            onClick={() => void syncModels(i)}
                            disabled={busy || !pf.apiBase || !pf.apiKey}
                            title="向服务商拉取当前可用的模型列表并替换本卡片的模型（预设里的模型名可能已下线）"
                          >
                            同步模型
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
                    // 默认补上还没配置的那家（按预设顺序轮）；服务商、地址、模型三者取自同一个预设。
                    // 旧写法各取各的：服务商写智谱、地址却取了预设表首项（小米），请求带着智谱专有参数发往小米
                    const used = new Set(profiles.map((p) => p.provider))
                    const preset = PRESETS.find((p) => p.id !== 'custom' && !used.has(p.id)) ?? PRESETS[0]
                    const next = [...profiles, { provider: preset.id, apiBase: preset.base, apiKey: '', models: [...preset.models] }]
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
                  <div className="ws-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11.5z" />
                    </svg>
                  </div>
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
                <div className="section-title">嵌入（Ollama）</div>
                <div className="field-row">
                  <div className="field grow">
                    <label>服务地址</label>
                    <input value={form.ollamaUrl ?? ''} onChange={(e) => set({ ollamaUrl: e.target.value })} placeholder="http://127.0.0.1:11434" />
                  </div>
                  <div className="field grow">
                    <label>模型</label>
                    <input value={form.ollamaEmbedModel ?? ''} onChange={(e) => set({ ollamaEmbedModel: e.target.value })} placeholder="qwen3-embedding:0.6b" />
                  </div>
                </div>
                <div className="test-row">
                  <button className="btn ghost" onClick={() => void testEmbed()} disabled={busy}>
                    测试嵌入
                  </button>
                  <span className="test-result">{embedTest}</span>
                  <span style={{ flex: 1 }} />
                  <span className="hint">模型由 Ollama 管理，先 ollama pull。</span>
                </div>
              </div>

              <div className="section">
                <div className="section-title">检索增强</div>
                <div className="field-row">
                  <div className="field grow">
                    <label>重排序</label>
                    <select value={form.rerankProvider ?? 'local'} onChange={(e) => set({ rerankProvider: e.target.value as Settings['rerankProvider'] })}>
                      <option value="local">开</option>
                      <option value="off">关</option>
                    </select>
                  </div>
                  <div className="field grow">
                    <label>查询预处理</label>
                    <select value={form.queryRewrite === false ? 'off' : 'on'} onChange={(e) => set({ queryRewrite: e.target.value === 'on' })}>
                      <option value="on">开</option>
                      <option value="off">关</option>
                    </select>
                  </div>
                  <div className="field grow">
                    <label>回答校验</label>
                    <select value={form.answerVerify === false ? 'off' : 'on'} onChange={(e) => set({ answerVerify: e.target.value === 'on' })}>
                      <option value="on">开</option>
                      <option value="off">关</option>
                    </select>
                  </div>
                </div>
                <div className="test-row">
                  <button className="btn ghost" onClick={() => void testRerankModel()} disabled={busy}>
                    测试重排序
                  </button>
                  <span className="test-result">{rerankTest}</span>
                  <span style={{ flex: 1 }} />
                  <span className="hint">重排模型首次使用自动下载。</span>
                </div>
              </div>

              <div className="section">
                <div className="section-title">索引</div>
                <div className="hint" style={{ marginTop: 0 }}>
                  已索引 {indexed.indexed}/{indexed.papers} 篇 · {indexed.chunks} 个文本块
                  {indexInfo ? ` · 正在处理 ${indexInfo.current ?? ''} (${indexInfo.done}/${indexInfo.total})` : ''}
                  · PDF 结构化解析（liteparse，无 OCR）内置
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
                  <span className="ws-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 6L4 12l5 6M15 6l5 6-5 6" />
                    </svg>
                  </span>
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
          {/* 主题 / 默认模型 / 服务商卡片改动即存，「取消」并不回滚它们——如实叫「关闭」 */}
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
