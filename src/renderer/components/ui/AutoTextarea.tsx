import { useLayoutEffect, useRef } from 'react'
import { INPUT_CLASS } from './input-styles'

/**
 * A textarea that grows to fit its content (wrapped text or explicit newlines)
 * — no manual resize handle. Lets a user write one yt-dlp flag per line instead
 * of cramming everything onto one line; the tokenizer treats newlines as
 * whitespace, so multi-line input is safe. `minRows` sets how tall it stands
 * while short, so a field that usually holds several lines looks like one
 * before anything is typed.
 */
export function AutoTextarea({
  value,
  onChange,
  placeholder,
  disabled,
  mono,
  minRows = 1,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  minRows?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Resize to content after every value change (and on mount, so a saved
  // multi-line value opens already expanded).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, minRows])

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      rows={minRows}
      spellCheck={false}
      className={`w-full resize-none overflow-hidden ${mono ? 'font-mono ' : ''}${INPUT_CLASS}`}
    />
  )
}
