import type { ReactNode } from 'react'
import { CloseIcon } from '@renderer/components/Icon'

type InlineErrorProps = {
  children: ReactNode
  className?: string
  id?: string
  onDismiss?: () => void
  closeLabel?: string
}

export function InlineError({
  children,
  className = '',
  id,
  onDismiss,
  closeLabel = 'Close result',
}: InlineErrorProps) {
  return (
    <div
      id={id}
      role="alert"
      aria-atomic="true"
      className={`relative rounded border border-red-900 bg-red-950/40 py-2 pr-10 pl-3 text-xs text-red-300 ${className}`}
    >
      <div className="min-w-0 whitespace-pre-wrap break-words">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={closeLabel}
          className="absolute top-1.5 right-2 grid h-6 w-6 place-items-center rounded border-0 bg-transparent p-0 text-red-300/80 hover:bg-red-900 hover:text-red-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-300"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  )
}
