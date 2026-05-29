import {
  useBinariesStore,
  allBinariesInstalled,
  binariesWithUpdate,
} from '@renderer/store/binaries'

/**
 * Thin footer bar. Surfaces tool state — missing binaries or available updates —
 * and always offers an entry point into the shared BinariesDialog.
 */
export function StatusBar() {
  const statuses = useBinariesStore((s) => s.statuses)
  const openModal = useBinariesStore((s) => s.openModal)

  const missing = statuses.filter((s) => s.installedVersion === null).length
  const updates = binariesWithUpdate(statuses).length

  return (
    <footer className="flex shrink-0 items-center justify-between border-t border-zinc-800 px-4 py-1.5 text-xs">
      <div>
        {missing > 0 ? (
          <span className="text-amber-300">
            {missing} {missing === 1 ? 'tool isn’t' : 'tools aren’t'} installed
          </span>
        ) : updates > 0 ? (
          <span className="text-sky-300">
            {updates} {updates === 1 ? 'update' : 'updates'} available
          </span>
        ) : allBinariesInstalled(statuses) ? (
          <span className="text-zinc-500">Tools up to date</span>
        ) : (
          <span className="text-zinc-600">Checking tools…</span>
        )}
      </div>
      <button
        onClick={() => openModal()}
        className="text-zinc-400 hover:text-zinc-100"
      >
        {missing > 0 ? 'Install' : updates > 0 ? 'Review' : 'Manage tools'}
      </button>
    </footer>
  )
}
