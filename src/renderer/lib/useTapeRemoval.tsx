import { useState, type ReactNode, type RefObject } from 'react'
import type { Tape } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { useSettingsStore } from '@renderer/store/settings'
import { releaseVideo } from '@renderer/lib/video'
import { advanceSelection } from '@renderer/lib/tapeActions'
import { RemoveTapeConfirmModal } from '@renderer/components/RemoveTapeConfirmModal'
import { runTapeAction } from '@renderer/lib/runTapeAction'

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
    const outcome = await runTapeAction(
      tape.id,
      'remove',
      'tape removal failed',
      'This tape could not be removed. It remains in the library; try again.',
      () => ipcInvoke('library:remove', { tapeIds: [tape.id], deleteFiles: true }),
    )
    if (outcome === 'succeeded') advance()
  }

  function requestRemove(tape: Tape): void {
    if (confirmEnabled) setPending(tape)
    else void perform(tape)
  }

  const confirmModal: ReactNode = pending ? (
    <RemoveTapeConfirmModal
      tape={pending}
      trashEnabled={trashEnabled}
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
