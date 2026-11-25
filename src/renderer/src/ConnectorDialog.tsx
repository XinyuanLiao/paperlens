import { useCallback, useEffect, useState } from 'react'
import type { ConnectorActivity, ConnectorInfo } from './types'

interface Props {
  // 库里现有的分类（默认分类的候选）
  cats: string[]
  // 配了 API Key 才能选「AI 自动归类」
  hasApiKey: boolean
  onClose: () => void
}

const STATUS_LABEL: Record<NonNullable<ConnectorActivity['status']>, string> = {
  saved: '已入库',
  duplicate: '已在文库',
  'no-pdf': '未取到全文',
  error: '失败'
}

const AI_AUTO = '__auto__'

// 「通过浏览器扩展导入」引导窗。工作方式参考 Zotero Connector：
// 应用在本机开一个只对扩展开放的 HTTP 服务，用户在浏览器里点一下扩展就把论文存进文库。
// 这里负责三件事：服务是否就绪、怎么装扩展、最近通过扩展存进来了什么
export default function ConnectorDialog({ cats, hasApiKey, onClose }: Props): JSX.Element | null {
  const [info, setInfo] = useState<ConnectorInfo | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api
        .connectorStatus()
        .then((s) => {
          if (alive && s) setInfo((cur) => (cur ? s : s))
        })
        .catch(() => {})
    }
    load()
    // 之后主进程每收到一个请求都会推过来，界面实时更新（探测只刷新「已连接」状态，保存追加到最近列表）
    const off = window.api.onConnectorActivity((a) => {
      setInfo((cur) => {
        if (!cur) return cur
        return {
          ...cur,
          seen: true,
          lastSeenAt: a.at,
          recent: a.kind === 'save' ? [a, ...cur.recent.filter((x) => x.at !== a.at)].slice(0, 20) : cur.recent
        }
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const flash = (text: string): void => {
    setMsg(text)
    setTimeout(() => setMsg((m) => (m === text ? '' : m)), 2200)
  }
  const copyPath = async (): Promise<void> => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(info.dir)
      flash('已复制扩展目录的路径')
    } catch {
      flash('复制失败：请手动选中路径复制')
    }
  }
  const openDir = async (): Promise<void> => {
    const err = await window.api.connectorOpenDir()
    if (err) flash(err)
  }
  const restart = async (): Promise<void> => {
    const s = await window.api.connectorRestart().catch(() => null)
    if (s) setInfo(s)
    else flash('重启失败')
  }
  const pickCategory = async (v: string): Promise<void> => {
    setInfo((cur) => (cur ? { ...cur, defaultCategory: v } : cur))
    await window.api.setConnectorCategory(v)
  }

  // 服务没起来时不让界面卡在空白上：照常显示，并在状态条里说明原因
  if (!info) return null
  const ready = info.running

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal connector-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>通过浏览器扩展导入</h2>
          <button className="modal-x" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-scroll connector-body">
          {/* 状态条：服务是否就绪 / 扩展是否连过 */}
          <div className={`connector-status ${ready ? 'on' : 'off'}`}>
            <span className="connector-dot" />
            <span className="ellipsis" title={info.error}>
              {ready
                ? `扩展导入服务已就绪 · 127.0.0.1:${info.port}${info.seen ? ' · 浏览器扩展已连接过' : ' · 等待浏览器扩展连接'}`
                : `扩展导入服务未启动${info.error ? `：${info.error}` : ''}`}
            </span>
            {!ready && (
              <button className="btn ghost" onClick={() => void restart()}>
                重新启动服务
              </button>
            )}
          </div>

          <div className="section">
            <div className="section-title">1 · 安装浏览器扩展（只需一次）</div>
            {!info.dirExists && (
              <div className="connector-warn">
                没有在扩展目录里找到 manifest.json（{info.dir}）。从源码运行时请确认项目里有 connector/ 目录；安装包版本请重新安装。
              </div>
            )}
            <div className="hint connector-p">
              适用于 Chrome、Edge 等 Chromium 内核浏览器。在扩展管理页（Chrome 是 <span className="kbd">chrome://extensions</span>，Edge 是{' '}
              <span className="kbd">edge://extensions</span>）打开右上角的「开发者模式」，点「加载已解压的扩展程序」，选择下面这个文件夹：
            </div>
            <div className="connector-path">
              <input readOnly value={info.dir} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn ghost" onClick={() => void copyPath()}>
                复制路径
              </button>
              <button className="btn ghost" onClick={() => void openDir()}>
                打开文件夹
              </button>
            </div>
            {msg && <div className="connector-msg">{msg}</div>}
          </div>

          <div className="section">
            <div className="section-title">2 · 在论文页面点一下扩展</div>
            <div className="hint connector-p">
              在浏览器里打开论文页面（IEEE Xplore 的 Document 页、arXiv 的摘要页等），点工具栏上的 PaperLens 图标 →「保存到 PaperLens」。
              PDF 由浏览器用当前的登录状态下载，所以需要机构权限的全文也能保存。
            </div>
            <div className="field" style={{ marginTop: 10, marginBottom: 8 }}>
              <label>默认保存到哪个分类</label>
              <select value={info.defaultCategory} onChange={(e) => void pickCategory(e.target.value)}>
                <option value="">未分类</option>
                {hasApiKey && <option value={AI_AUTO}>AI 自动归类</option>}
                {cats.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <div className="hint">扩展的弹窗里每次保存前还能单独改。</div>
            </div>
          </div>

          <div className="section">
            <div className="section-title">3 · 最近通过扩展导入</div>
            {info.recent.length === 0 ? (
              <div className="connector-empty">还没有通过扩展导入过文献。</div>
            ) : (
              <div className="connector-list">
                {info.recent.map((a) => (
                  <div key={a.at} className={`connector-row ${a.status ?? 'error'}`} title={a.message ?? a.title}>
                    <span className="connector-row-status">{STATUS_LABEL[a.status ?? 'error']}</span>
                    <span className="ellipsis">{a.title || a.message}</span>
                    <span className="connector-row-time">{new Date(a.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button className="connector-help-toggle" onClick={() => setShowHelp((v) => !v)}>
            <span className={`chev ${showHelp ? 'open' : ''}`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </span>
            连不上？常见问题
          </button>
          {showHelp && (
            <div className="connector-help">
              <div>· 扩展显示「未连接」：确认 PaperLens 正在运行，再点一次扩展图标。公司电脑上的安全软件可能拦截本机回环端口。</div>
              <div>· 每个站点第一次保存时，浏览器会问「是否允许扩展读取和更改该站点的数据」——请点「允许」，PDF 要靠这个权限带着登录状态去下载。拒绝过的话可以在扩展管理页里重新授权。</div>
              <div>· 取不到全文：先在浏览器里登录机构账号；仍然不行就先用浏览器打开 PDF 页面，再点扩展保存。</div>
              <div>· 保存成功后回到 PaperLens，新文献已经自动在阅读区打开。</div>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <span className="hint" style={{ flex: 1 }}>
            {ready ? '服务随 PaperLens 一起运行，退出应用后停止。' : '服务启动后才能接收扩展发来的文献。'}
          </span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
