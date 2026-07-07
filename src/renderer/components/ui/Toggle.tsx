type Props = {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}

/**
 * A checkbox with a label and optional description beneath it.
 *
 * Laid out as a grid rather than a flex row so the checkbox aligns to its *label*
 * line, not to the top of the whole label+description block: the checkbox and
 * label share row 1 (vertically centred together), and the description occupies
 * row 2 under the label. That's why there's no manual top-margin nudge on the box.
 */
export function Toggle({ label, description, checked, disabled, onChange }: Props) {
  return (
    <label className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-0.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="text-sm">{label}</div>
      {description && <div className="col-start-2 text-xs text-zinc-300">{description}</div>}
    </label>
  )
}
