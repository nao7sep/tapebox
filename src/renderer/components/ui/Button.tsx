import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Spinner'

/**
 * Semantic button variants. Variants describe intent, not just colour, so the
 * whole UI can be re-skinned by editing the maps below without touching call
 * sites.
 *
 *   primary      — main CTA in a modal/toolbar (Save, Add, Install all)
 *   secondary    — outlined, less-emphasized inline action (Choose, Select all)
 *   ghost        — outlined neutral, low-emphasis (Cancel, Close)
 *   dangerOutline — outlined destructive, inline (Remove a row, Clear a key)
 *   danger       — filled destructive, for final confirmations (Discard, Delete)
 *   warm         — filled attention (Install / Update when actionable)
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'dangerOutline'
  | 'danger'
  | 'warm'

export type ButtonSize = 'sm' | 'md'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Show a leading spinner and disable the button while an action is running. */
  loading?: boolean
  children: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-inverse text-on-inverse font-medium hover:bg-inverse-hover disabled:bg-raised-hover disabled:text-fg',
  secondary:
    'border border-line text-fg hover:bg-raised disabled:opacity-50',
  ghost:
    'border border-line text-fg hover:border-line-strong hover:text-fg-strong disabled:opacity-50',
  dangerOutline:
    'border border-danger-line text-danger-fg hover:border-danger-line-strong hover:bg-danger-tint disabled:opacity-50',
  danger:
    'bg-danger-fill text-on-danger font-medium hover:bg-danger-fill-hover disabled:opacity-50',
  warm:
    'bg-warm-fill text-on-warm font-medium hover:bg-warm-fill-hover disabled:opacity-50',
}

// Both sizes share text-sm so inline actions read as the same weight as the
// primary buttons beside them; sm just trims the padding. sm's height matches
// INPUT_CLASS (py-1.5 text-sm), so a button sitting next to an input lines up.
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  type = 'button',
  children,
  ...rest
}: Props) {
  const cls =
    `inline-flex items-center justify-center gap-1.5 rounded transition ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`.trim()
  return (
    <button type={type} disabled={disabled || loading} className={cls} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  )
}
