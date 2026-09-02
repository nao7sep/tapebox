import type { ReactNode } from 'react'
import { CloseIcon, ErrorIcon } from '@renderer/components/Icon'

type InlineErrorProps = {
  children: ReactNode
  className?: string
  id?: string
  onDismiss?: () => void
  dismissLabel?: string
}

export function InlineError({
  children,
  className = '',
  id,
  onDismiss,
  dismissLabel = 'Dismiss error',
}: InlineErrorProps) {
  return (
    <div
      id={id}
      role="alert"
      aria-atomic="true"
      className={`flex items-start gap-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300 ${className}`}
    >
      <strong className="inline-flex shrink-0 items-center gap-1 font-semibold">
        <ErrorIcon />
        Error
      </strong>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="shrink-0 rounded p-0.5 text-red-300/80 hover:bg-red-900 hover:text-red-100"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  )
}
