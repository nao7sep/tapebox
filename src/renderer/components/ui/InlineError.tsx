import type { ReactNode } from 'react'
import { ErrorIcon } from '@renderer/components/Icon'

export function InlineError({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="alert"
      aria-atomic="true"
      className={`flex items-start gap-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300 ${className}`}
    >
      <strong className="inline-flex shrink-0 items-center gap-1 font-semibold">
        <ErrorIcon />
        Error
      </strong>
      <span className="min-w-0 whitespace-pre-wrap break-words">{children}</span>
    </div>
  )
}
