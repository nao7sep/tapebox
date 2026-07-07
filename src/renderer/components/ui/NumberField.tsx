import { INPUT_CLASS } from './input-styles'

type Props = {
  label: string
  value: number
  min: number
  max: number
  disabled?: boolean
  onChange: (v: number) => void
}

export function NumberField({ label, value, min, max, disabled, onChange }: Props) {
  return (
    <label className="block">
      <span className="text-xs text-zinc-300">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(min, Math.min(max, parseInt(e.target.value || '0', 10))))}
        className={`mt-1 w-full ${INPUT_CLASS}`}
      />
    </label>
  )
}
