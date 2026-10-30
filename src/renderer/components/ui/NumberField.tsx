import { useId } from 'react'
import { INPUT_LINE_CLASS } from './input-styles'

type Props = {
  label: string
  /** Exactly what the user typed; the field never rewrites it. */
  text: string
  /** Shown under the field while the text is not an accepted value. */
  error?: string
  disabled?: boolean
  onChange: (text: string) => void
}

export function NumberField({ label, text, error, disabled, onChange }: Props) {
  const errorId = useId()
  return (
    <label className="block">
      <span className="text-xs text-fg">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        spellCheck={false}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full ${INPUT_LINE_CLASS}`}
      />
      {error && <span id={errorId} className="mt-1 block text-xs text-danger-fg">{error}</span>}
    </label>
  )
}

/** The whole number `text` names within [min, max], or null. Surrounding
 *  spaces are allowed; signs, fractions and exponents are not. */
export function parseWholeNumber(text: string, min: number, max: number): number | null {
  const trimmed = text.trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= min && value <= max ? value : null
}
