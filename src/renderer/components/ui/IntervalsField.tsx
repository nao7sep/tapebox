import { useState } from 'react'
import { INPUT_CLASS } from './input-styles'

type Props = {
  /** Caption above the input, e.g. "Retry intervals in seconds…". */
  label: string
  /** Intervals as milliseconds; displayed/edited as seconds. */
  intervals: number[]
  disabled?: boolean
  onChange: (intervalsMs: number[]) => void
}

/**
 * Comma-separated number list, parsed on blur/Enter. Input shows seconds,
 * onChange emits milliseconds. Invalid tokens are silently dropped.
 */
export function IntervalsField({ label, intervals, disabled, onChange }: Props) {
  const [text, setText] = useState(() => intervals.map((ms) => ms / 1000).join(', '))

  function commit() {
    const arr = text
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => Math.round(parseFloat(t) * 1000))
      .filter((ms) => Number.isFinite(ms) && ms >= 0)
    onChange(arr)
    setText(arr.map((ms) => ms / 1000).join(', '))
  }

  return (
    <label className="block">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        type="text"
        value={text}
        disabled={disabled}
        spellCheck={false}
        placeholder="1, 3, 8"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        className={`mt-1 w-full ${INPUT_CLASS}`}
      />
    </label>
  )
}
