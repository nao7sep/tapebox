import { useState, type ReactNode, type RefObject } from 'react'
import type { Item } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { useSelectionStore } from '@renderer/store/selection'
import { useSettingsStore } from '@renderer/store/settings'
import { useVisibleItems } from '@renderer/lib/itemOrder'
import { releaseVideo } from '@renderer/lib/video'
import { ConfirmModal } from '@renderer/components/ConfirmModal'

/**
 * The single removal flow, shared by the Remove button and the keyboard
 * shortcut. Removing a tape selects its neighbor (next, else previous, else
 * none), optionally behind a confirmation, and moves files to Trash or deletes
 * them per settings — both decided by the persisted Settings.
 *
 * Returns `requestRemove` to trigger it and `confirmModal` to render (null
 * unless a confirmation is pending). The video element is released before the
 * file is touched, so callers pass the player ref.
 */
export function useItemRemoval(videoRef: RefObject<HTMLVideoElement | null>): {
  requestRemove: (item: Item) => void
  confirmModal: ReactNode
} {
  const visible = useVisibleItems()
  const select = useSelectionStore((s) => s.select)
  const confirmEnabled = useSettingsStore((s) => s.settings?.confirmRemove ?? true)
  const trashEnabled = useSettingsStore((s) => s.settings?.trashOnRemove ?? true)
  const [pending, setPending] = useState<Item | null>(null)

  /** The item to select after `item` is gone: next, else previous, else null. */
  function neighborId(item: Item): string | null {
    const idx = visible.findIndex((i) => i.id === item.id)
    if (idx === -1) return null
    return (visible[idx + 1] ?? visible[idx - 1])?.id ?? null
  }

  async function perform(item: Item): Promise<void> {
    const next = neighborId(item)
    releaseVideo(videoRef.current)
    await ipcInvoke('library:remove', { itemIds: [item.id], deleteFiles: true })
    select(next)
  }

  function requestRemove(item: Item): void {
    if (confirmEnabled) setPending(item)
    else void perform(item)
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
        const item = pending
        setPending(null)
        if (item) void perform(item)
      }}
    />
  ) : null

  return { requestRemove, confirmModal }
}
