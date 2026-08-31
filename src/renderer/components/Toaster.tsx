import { useToastStore } from '@renderer/store/toast'
import { CloseIcon, ErrorIcon } from './Icon'

/**
 * Floating stack of error toasts, bottom-right above the status bar. Errors
 * never auto-dismiss — each carries a close button and stays until the user
 * clears it, so a failure message can't disappear before it's read. Info toasts
 * live in the status bar instead (see StatusBar), so this renders errors only.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  const errors = toasts.filter((t) => t.kind === 'error')
  if (errors.length === 0) return null

  return (
    // Toasts sit at z-[45]: above menus / drop overlays (z-40) but below modals (z-50),
    // so an error toast never obscures an open modal's controls (it waits behind it).
    <div className="pointer-events-none fixed bottom-4 right-4 z-[45] flex w-full max-w-md flex-col gap-2">
      {errors.map((t) => (
        <div
          key={t.id}
          role="alert"
          aria-atomic="true"
          className="pointer-events-auto flex items-start gap-3 rounded-lg border border-red-800 bg-red-950/95 px-4 py-3 text-sm text-red-200 shadow-lg"
        >
          <strong className="inline-flex shrink-0 items-center gap-1 font-semibold">
            <ErrorIcon />
            Error
          </strong>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{t.text}</span>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded px-1 leading-none text-red-300/80 hover:text-red-100"
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  )
}
