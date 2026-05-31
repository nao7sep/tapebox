import { useState } from 'react'
import { INPUT_CLASS } from './input-styles'

type Props = {
  label: string
  /** Timeout in ms, or null for "no timeout". */
  ms: number | null
  /** Bounds in seconds. */
  min: number
  max: number
  disabled?: boolean
  onChange: (ms: number | null) => void
}

/**
 * Seconds input that can also express "no timeout": an empty field commits null.
 * Mirrors IntervalsField — local text, parsed on blur/Enter.
 */
export function TimeoutField({ label, ms, min, max, disabled, onChange }: Props) {
  const [text, setText] = useState(() => (ms == null ? '' : String(Math.round(ms / 1000))))

  function commit() {
    const secs = parseFloat(text.trim())
    if (!Number.isFinite(secs)) {
      onChange(null)
      setText('')
      return
    }
    const clamped = Math.max(min, Math.min(max, Math.round(secs)))
    onChange(clamped * 1000)
    setText(String(clamped))
  }

  return (
    <label className="block">
      <span className="text-xs text-zinc-300">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        placeholder="off"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        className={`mt-1 w-full ${INPUT_CLASS}`}
      />
    </label>
  )
}
