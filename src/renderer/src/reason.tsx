import { useCallback, useState } from 'react'

// 思考模型的推理过程提示（reasoning_content）。
// K3 / DeepSeek-R1 / GLM 这类模型在正文之前先输出一大段推理，期间界面原本只有三个点，
// 等得稍久就像是「没接上」。这里把最近一小段推理实时显示出来，让用户看到模型确实在动。
// 只为反馈而展示：不完整保存、不进对话历史，正文一开始就收起

const KEEP = 3000 // 累计上限：超长后只留后半，避免长思考把状态撑大

export function useReasoning(): { text: string; onReason: (t: string) => void; clear: () => void } {
  const [text, setText] = useState('')
  const onReason = useCallback((t: string) => {
    setText((prev) => (prev.length > KEEP ? prev.slice(-KEEP / 2) + t : prev + t))
  }, [])
  const clear = useCallback(() => setText(''), [])
  return { text, onReason, clear }
}

export function ReasonStrip({ text }: { text: string }): JSX.Element | null {
  if (!text.trim()) return null
  return (
    <div className="reason-strip" title="模型正在推理；思考过程不保存，正文开始后收起">
      <span className="reason-label">
        <span className="reason-dot" />
        深度思考中 · {text.length > KEEP ? `${KEEP}+` : text.length} 字
      </span>
      <span className="reason-text">{text}</span>
    </div>
  )
}
