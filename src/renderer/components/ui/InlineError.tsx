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
      className={`relative rounded border border-danger-line bg-danger-tint py-2 pr-10 pl-3 text-xs text-danger-fg ${className}`}
    >
      <div className="min-w-0 whitespace-pre-wrap break-words">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={closeLabel}
          className="absolute top-1.5 right-2 grid h-6 w-6 place-items-center rounded border-0 bg-transparent p-0 text-danger-fg/80 hover:bg-danger-hover hover:text-danger-fg-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-danger-fg"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  )
}
