import {
  useBinariesStore,
  binariesWithUpdate,
  updatesChecked,
} from '@renderer/store/binaries'
import { useNoticeStore } from '@renderer/store/notice'

/**
 * Thin footer bar. A transient notice (import results, etc.) takes precedence
 * when present; otherwise it reflects tool state from the shared store (kept in
 * sync by both the startup auto-check and the tools modal). "Updates not
 * checked" covers both auto-check being off and a check that failed. Acting on
 * tool state lives in the header menu's "Required tools".
 */
export function StatusBar() {
  const statuses = useBinariesStore((s) => s.statuses)
  const checking = useBinariesStore((s) => s.checking)
  const notice = useNoticeStore((s) => s.notice)

  const loaded = statuses.length > 0
  const missing = statuses.filter((s) => s.installedVersion === null).length
  const updates = binariesWithUpdate(statuses).length

  return (
    <footer className="flex shrink-0 items-center border-t border-zinc-800 px-4 py-1.5 text-xs">
      {notice ? (
        <span className={notice.kind === 'error' ? 'text-red-400' : 'text-zinc-300'}>
          {notice.text}
        </span>
      ) : !loaded ? (
        <span className="text-zinc-400">Loading…</span>
      ) : missing > 0 ? (
        <span className="text-amber-300">
          {missing} {missing === 1 ? 'tool isn’t' : 'tools aren’t'} installed
        </span>
      ) : checking ? (
        <span className="text-zinc-400">Checking for updates…</span>
      ) : updates > 0 ? (
        <span className="text-sky-300">
          {updates} {updates === 1 ? 'update' : 'updates'} available
        </span>
      ) : updatesChecked(statuses) ? (
        <span className="text-zinc-400">Tools up to date</span>
      ) : (
        <span className="text-zinc-400">Updates not checked</span>
      )}
    </footer>
  )
}
