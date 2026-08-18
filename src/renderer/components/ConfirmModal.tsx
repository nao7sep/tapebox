import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/ui'

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
 * Two-button confirmation on the shared Modal base. Cancel sits left, the
 * primary action on the right; `danger` styles the primary red for irreversible
 * choices like discarding edits.
 */
export function ConfirmModal({
  title = 'Confirm',
  message,
  cancelLabel = 'Cancel',
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: Props) {
  const footer = (
    <>
      {/* Cancel takes focus, named here rather than left to markup order: a
          confirmation exists because something could go wrong, so the action a
          reflexive Enter reaches must be the one that costs nothing. */}
      <Button variant="ghost" autoFocus onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </>
  )

  return (
    <Modal title={title} onClose={onCancel} size="md" footer={footer}>
      <p className="text-sm text-zinc-300">{message}</p>
    </Modal>
  )
}
