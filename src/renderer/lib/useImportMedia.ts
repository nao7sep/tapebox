import { ipcInvoke } from '@renderer/ipc/client'
import { useImportResultStore } from '@renderer/store/importResult'

/**
 * Import media files into the library by path and surface the outcome as a
 * blocking results modal. Shared by the drag-and-drop zone and the file-picker
 * menu item — both resolve to a list of media paths, which the main handler
 * pairs with sidecars by stem (a media file with no matching .json is
 * rejected). A no-op on an empty list (e.g. a cancelled picker).
 *
 * The result is pushed to the import-result store; <ImportResultModal> at the
 * app root renders it. An IPC-level failure (rare — the handler rejects
 * per-file internally) is shown through the same modal, with every attempted
 * file listed as failed under that error.
 */
export function useImportMedia(): (mediaPaths: string[]) => Promise<void> {
  const show = useImportResultStore((s) => s.show)
  return async (mediaPaths) => {
    if (mediaPaths.length === 0) return
    try {
      const result = await ipcInvoke('library:import', { mediaPaths })
      show(result)
    } catch (err) {
      show({
        imported: [],
        rejected: mediaPaths.map((path) => ({ path, reason: String(err) })),
      })
    }
  }
}
