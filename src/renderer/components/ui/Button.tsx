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

// Each variant answers a press with a further step of its own surface, one beyond
// its hover in the direction that theme's hover already moves. Without one, a
// press shows nothing at all, and a button that shows nothing reads as a button
// that did nothing until whatever it started finishes.
//
// Off, a variant is its resting self faded, at the one value the app states.
// Primary used to swap its near-black fill for a raised grey and its inverted ink
// for the ordinary one, which turned the most emphatic control in the app into a
// slab that no longer read as the primary — alone among the six in doing so.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-inverse text-on-inverse font-medium hover:bg-inverse-hover active:bg-inverse-active disabled:opacity-50',
  secondary:
    'border border-line text-fg hover:bg-raised active:bg-raised-hover disabled:opacity-50',
  ghost:
    'border border-line text-fg hover:border-line-strong hover:text-fg-strong active:border-line-hover disabled:opacity-50',
  // Its pressed tint is the danger banner's fill, which is already the next step
  // down from the hover tint in both themes; a second token of the same value
  // would say nothing more.
  dangerOutline:
    'border border-danger-line text-danger-fg hover:border-danger-line-strong hover:bg-danger-tint active:border-danger-line-hover active:bg-danger-banner disabled:opacity-50',
  danger:
    'bg-danger-fill text-on-danger font-medium hover:bg-danger-fill-hover active:bg-danger-fill-active disabled:opacity-50',
  warm:
    'bg-warm-fill text-on-warm font-medium hover:bg-warm-fill-hover active:bg-warm-fill-active disabled:opacity-50',
}

// Both sizes share text-sm so inline actions read as the same weight as the
// primary buttons beside them; sm just trims the width. The height is fixed
// rather than grown from padding, so a bordered variant and a filled one are
// the same height in the same row, and sm matches INPUT_CLASS's height, so a
// button sitting next to an input lines up.
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-4 text-sm',
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
