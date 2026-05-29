import { Dialog } from '@renderer/components/Dialog'

type Props = {
  title?: string
  message: string
  cancelLabel?: string
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Two-button confirmation on the shared Dialog base. Cancel sits left, the
 * primary action on the right; `danger` styles the primary red for irreversible
 * choices like discarding edits.
 */
export function ConfirmDialog({
  title = 'Confirm',
  message,
  cancelLabel = 'Cancel',
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: Props) {
  const primaryClass = danger
    ? 'rounded bg-red-600 px-4 py-2 text-sm font-medium text-zinc-50 hover:bg-red-500'
    : 'rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-zinc-200'

  const footer = (
    <>
      <button
        onClick={onCancel}
        className="rounded px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100"
      >
        {cancelLabel}
      </button>
      <button onClick={onConfirm} className={primaryClass}>
        {confirmLabel}
      </button>
    </>
  )

  return (
    <Dialog title={title} onClose={onCancel} size="md" footer={footer}>
      <p className="text-sm text-zinc-300">{message}</p>
    </Dialog>
  )
}
