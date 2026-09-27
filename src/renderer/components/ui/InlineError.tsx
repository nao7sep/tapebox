import type { ReactNode } from 'react'
import { CloseIcon } from '@renderer/components/Icon'
import { useI18n } from '@renderer/i18n/I18nContext'

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
  closeLabel,
}: InlineErrorProps) {
  const t = useI18n()
  return (
    <div
      id={id}
      role="alert"
      aria-atomic="true"
      className={`flex items-start gap-2 rounded border border-danger-line bg-danger-tint py-2 pr-3 pl-3 text-xs text-danger-fg ${className}`}
    >
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={closeLabel ?? t.t('common.closeResult')}
          // Centred on the first text line, not the whole (possibly wrapped) block: the
          // row is top-aligned, and this nudges the button up/down by half the gap
          // between the text-xs line height and the button's own h-6 size. Same
          // mechanism as chachat's .cc-state-notice__dismiss margin-block.
          style={{ marginTop: 'calc((var(--text-xs--line-height) - 1.5rem) / 2)' }}
          className="grid h-6 w-6 shrink-0 place-items-center rounded border-0 bg-transparent p-0 text-danger-fg/80 hover:bg-danger-hover hover:text-danger-fg-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-danger-fg"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  )
}
