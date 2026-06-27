import type { Tape } from '@shared/domain'
import { ConfirmModal } from '@renderer/components/ConfirmModal'

type Props = {
  tape: Tape
  trashEnabled: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Confirmation for removing a tape from the library. The message and commit
 * label adapt to the tape's state: a still-downloading tape has no file to
 * remove; otherwise the wording reflects whether files go to the Trash
 * (restorable) or are deleted permanently, per the trash-on-remove setting.
 *
 * The removal orchestration (pending state, video-handle release, selection
 * advance) lives in the useTapeRemoval hook; this is just the named surface so
 * the confirm is findable by filename rather than buried in the hook.
 */
export function RemoveTapeConfirmModal({ tape, trashEnabled, onCancel, onConfirm }: Props) {
  return (
    <ConfirmModal
      title="Remove tape"
      message={
        !tape.filename
          ? "Remove this tape from the library? It hasn't finished downloading, so there's no file to remove."
          : trashEnabled
            ? 'Move this tape to the Trash? You can restore it from there.'
            : "Permanently delete this tape's files? This can't be undone."
      }
      confirmLabel={!tape.filename ? 'Remove' : trashEnabled ? 'Move to Trash' : 'Delete'}
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
