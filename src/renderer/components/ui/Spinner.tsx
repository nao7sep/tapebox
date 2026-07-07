/**
 * Inline activity spinner — sized in `em` so it tracks the surrounding text and
 * coloured by `currentColor`. The single moving indicator used across the app
 * (busy buttons, modal loading bodies, the status bar) so "something is
 * happening" always looks the same.
 */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
