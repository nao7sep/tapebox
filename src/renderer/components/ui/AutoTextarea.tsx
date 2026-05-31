import { useLayoutEffect, useRef } from 'react'
import { INPUT_CLASS } from './input-styles'

/**
 * A textarea that shows as a single line at rest and grows to fit its content
 * (wrapped text or explicit newlines) — no manual resize handle. Lets a user
 * write one yt-dlp flag per line instead of cramming everything onto one line;
 * the tokenizer treats newlines as whitespace, so multi-line input is safe.
 */
export function AutoTextarea({
  value,
  onChange,
  placeholder,
  disabled,
  mono,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  mono?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Resize to content after every value change (and on mount, so a saved
  // multi-line value opens already expanded).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      spellCheck={false}
      className={`w-full resize-none overflow-hidden ${mono ? 'font-mono ' : ''}${INPUT_CLASS}`}
    />
  )
}
