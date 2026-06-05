import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Spinner'

/**
 * Semantic button variants. Variants describe intent, not just colour, so the
 * whole UI can be re-skinned by editing the maps below without touching call
 * sites.
 *
 *   primary     — main CTA in a modal/toolbar (Save, Add, Install all)
 *   secondary   — outlined, less-emphasized inline action (Choose, Select all)
 *   ghost       — outlined neutral, low-emphasis (Cancel, Close)
 *   ghostDanger — text-only destructive (Clear key)
 *   danger      — filled destructive (Discard, Delete)
 *   warm        — filled attention (Install / Update when actionable)
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'ghostDanger'
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
    'bg-zinc-50 text-zinc-950 font-medium hover:bg-zinc-200 disabled:bg-zinc-700 disabled:text-zinc-300',
  secondary:
    'border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50',
  ghost:
    'border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-50',
  ghostDanger:
    'text-red-400 hover:text-red-300 disabled:opacity-50',
  danger:
    'bg-red-600 text-zinc-50 font-medium hover:bg-red-500 disabled:opacity-50',
  warm:
    'bg-amber-500 text-zinc-950 font-medium hover:bg-amber-400 disabled:opacity-50',
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-3 py-1 text-xs',
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
