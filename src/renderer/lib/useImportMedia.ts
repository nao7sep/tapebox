import { ipcInvoke } from '@renderer/ipc/client'
import { useNoticeStore } from '@renderer/store/notice'

/**
 * Import media files into the library by path and surface the outcome as an app
 * notice. Shared by the drag-and-drop zone and the file-picker menu item — both
 * resolve to a list of media paths, which the main handler pairs with sidecars
 * by stem. A no-op on an empty list (e.g. a cancelled picker).
 */
export function useImportMedia(): (mediaPaths: string[]) => Promise<void> {
  const notify = useNoticeStore((s) => s.notify)
  return async (mediaPaths) => {
    if (mediaPaths.length === 0) return
    try {
      const { imported, rejected } = await ipcInvoke('library:import', { mediaPaths })
      if (rejected.length > 0) {
        // The status bar shows only the headline; keep the reasons reachable.
        console.warn('import rejected:', rejected)
      }
      notify(
        `Imported ${imported.length}${rejected.length ? `, ${rejected.length} rejected` : ''}`,
        rejected.length > 0 ? 'error' : 'info',
      )
    } catch (err) {
      notify(`Import failed: ${String(err)}`, 'error')
    }
  }
}
