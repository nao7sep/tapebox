import { INPUT_CLASS } from './input-styles'

type Props = {
  label: string
  value: string
  placeholder?: string
  disabled?: boolean
  type?: 'text' | 'password'
  onChange: (v: string) => void
}

export function TextField({ label, value, placeholder, disabled, type = 'text', onChange }: Props) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full ${INPUT_CLASS}`}
      />
    </label>
  )
}
