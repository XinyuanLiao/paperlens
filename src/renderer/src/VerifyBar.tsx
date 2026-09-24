import { useState } from 'react'
import type { VerifyReport } from './types'

const TYPE_LABEL: Record<string, string> = { citation: '引用', fact: '事实', logic: '逻辑' }

// 回答下方的校验条：✓ 通过 / ⚠ 问题数，点开看清单（类型 + 详情 + 涉及引用）。
// level=skipped（中断/空回答）不渲染
export default function VerifyBar({ v }: { v: VerifyReport }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (v.level === 'skipped') return null
  if (!v.issues.length) {
    return (
      <div className="verify-bar pass">
        <span className="verify-chip">✓ 已校验</span>
        <span className="verify-note">引用编号完整，未发现问题</span>
      </div>
    )
  }
  const errs = v.issues.filter((x) => x.severity === 'error').length
  return (
    <div className={`verify-bar ${errs ? 'error' : 'warn'}`}>
      <button className="verify-toggle" onClick={() => setOpen((o) => !o)} title="展开 / 收起校验问题清单">
        <span className="verify-chip">
          {errs ? '✗' : '⚠'} 校验发现 {v.issues.length} 个问题 {errs ? `（${errs} 严重）` : ''} {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="verify-issues">
          {v.issues.map((it, k) => (
            <div key={k} className={`verify-issue ${it.severity}`}>
              <span className={`vi-type ${it.type}`}>{TYPE_LABEL[it.type] ?? it.type}</span>
              <span className="vi-detail">
                {it.detail}
                {it.refs?.length ? <span className="vi-refs">（涉及 {it.refs.map((r) => `[${r}]`).join(' ')}）</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
