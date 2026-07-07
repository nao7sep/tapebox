import { ipcInvoke } from '@renderer/ipc/client'
import { useImportResultStore } from '@renderer/store/importResult'
import { useToastStore } from '@renderer/store/toast'

/**
 * The single import path. Both entry points — the drag-and-drop zone and the
 * file-picker menu item — hand this whatever paths the user gave (dropped files,
 * picked files), and it does the rest: keep only the .json sidecars, then import.
 * Each sidecar names its own media + thumbnail (read by the main handler), so the
 * caller never has to know that; it just passes paths.
 *
 * Empty input (a cancelled picker, a drag with no files) is a silent no-op. A
 * non-empty selection with no sidecars gets a guidance toast — that's the case
 * where the user dropped/picked the wrong thing (a bare video, say). Otherwise the
 * result is pushed to the import-result store and <ImportResultModal> renders it;
 * an IPC-level failure (rare — the handler rejects per-sidecar internally) surfaces
 * through the same modal, every attempted sidecar listed as failed under that error.
 */
export function useImportMedia(): (paths: string[]) => Promise<void> {
  const show = useImportResultStore((s) => s.show)
  const notify = useToastStore((s) => s.notify)
  return async (paths) => {
    if (paths.length === 0) return // nothing chosen / drag had no files — stay silent
    const sidecarPaths = paths.filter((p) => p.toLowerCase().endsWith('.json'))
    if (sidecarPaths.length === 0) {
      notify('No .json sidecars in that selection — TapeBox imports each tape from its sidecar (the video and image come along).', 'info')
      return
    }
    try {
      const result = await ipcInvoke('library:import', { sidecarPaths })
      show(result)
    } catch (err) {
      show({
        imported: [],
        rejected: sidecarPaths.map((path) => ({ path, reason: String(err) })),
      })
    }
  }
}
