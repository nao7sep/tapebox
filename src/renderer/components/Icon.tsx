/**
 * The app's icons: inline SVG on a 24 grid with `currentColor`, matching the house style
 * the Spinner and the row icons already use. They replace typed glyphs (✕ ✓ ↓ ↗ +) whose
 * size and weight varied with the font rather than with the text beside them.
 *
 * Each icon's rendered ink is fitted to the ink box measured off the glyph it replaces, so
 * a mark takes the space its character did without hanging below the baseline. `1em` ties
 * the size to the control's own font size; call sites set nothing else.
 *
 * Shared here rather than kept beside one caller, so a second use cannot fork into a
 * second drawing of the same mark.
 */

type IconProps = { className?: string }

function IconBase({ children, className = '' }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // Tailwind's preflight makes every svg `display: block`, which drops an inline
      // icon onto its own line and silently disables vertical-align. Declare inline
      // here, once, so no call site has to know about the preflight.
      style={{ display: 'inline-block', verticalAlign: '-0.1667em' }}
    >
      {children}
    </svg>
  )
}

export function CloseIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M18.92 4.30L5.08 19.00" />
      <path d="M5.08 4.30L18.92 19.00" />
    </IconBase>
  )
}

export function CheckIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M19.05 5.58L9.60 19.00L4.95 13.20" />
    </IconBase>
  )
}

export function ArrowDownIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M12.00 4.36L12.00 19.00" />
      <path d="M5.97 13.40L12.00 19.00L18.03 13.40" />
    </IconBase>
  )
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M16.32 11.80L16.32 19.00L4.80 19.00L4.80 7.48L12.00 7.48" />
      <path d="M13.44 4.12L19.20 4.12L19.20 9.88" />
      <path d="M19.20 4.12L11.04 12.28" />
    </IconBase>
  )
}

export function PlusIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M5.75 11.54L18.25 11.54" />
      <path d="M12.00 5.29L12.00 17.79" />
    </IconBase>
  )
}

export function ErrorIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V13" />
      <path d="M12 16.5H12.01" />
    </IconBase>
  )
}
