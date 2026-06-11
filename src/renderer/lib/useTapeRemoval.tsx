import { useState, type ReactNode, type RefObject } from 'react'
import type { Tape } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { useSettingsStore } from '@renderer/store/settings'
import { releaseVideo } from '@renderer/lib/video'
import { advanceSelection } from '@renderer/lib/tapeActions'
import { ConfirmModal } from '@renderer/components/ConfirmModal'

/**
 * The single removal flow, shared by the Remove button and the keyboard
 * shortcut. Delete always follows the 'list' policy (there's no item to follow
 * once it's gone): selection advances to the neighbor via the shared
 * advanceSelection, optionally behind a confirmation, and files go to Trash or
 * are deleted per settings. The video is released before the file is touched.
 *
 * Returns `requestRemove` to trigger it and `confirmModal` to render (null
 * unless a confirmation is pending). Callers pass the player ref.
 */
export function useTapeRemoval(videoRef: RefObject<HTMLVideoElement | null>): {
  requestRemove: (tape: Tape) => void
  confirmModal: ReactNode
} {
  const confirmEnabled = useSettingsStore((s) => s.settings?.confirmRemove ?? true)
  const trashEnabled = useSettingsStore((s) => s.settings?.trashOnRemove ?? true)
  const [pending, setPending] = useState<Tape | null>(null)

  async function perform(tape: Tape): Promise<void> {
    const advance = advanceSelection(tape) // captures the neighbor before removal
    releaseVideo(videoRef.current)
    await ipcInvoke('library:remove', { tapeIds: [tape.id], deleteFiles: true })
    advance()
  }

  function requestRemove(tape: Tape): void {
    if (confirmEnabled) setPending(tape)
    else void perform(tape)
  }

  const confirmModal: ReactNode = pending ? (
    <ConfirmModal
      title="Remove tape"
      message={
        !pending.filename
          ? "Remove this tape from the library? It hasn't finished downloading, so there's no file to remove."
          : trashEnabled
            ? 'Move this tape to the Trash? You can restore it from there.'
            : "Permanently delete this tape's files? This can't be undone."
      }
      confirmLabel={!pending.filename ? 'Remove' : trashEnabled ? 'Move to Trash' : 'Delete'}
      danger
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const tape = pending
        setPending(null)
        if (tape) void perform(tape)
      }}
    />
  ) : null

  return { requestRemove, confirmModal }
}
