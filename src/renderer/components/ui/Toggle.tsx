type Props = {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}

export function Toggle({ label, description, checked, disabled, onChange }: Props) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <div className="text-sm">{label}</div>
        {description && <div className="text-xs text-zinc-300">{description}</div>}
      </div>
    </label>
  )
}
