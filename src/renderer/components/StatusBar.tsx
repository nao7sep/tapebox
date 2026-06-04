import type { ReactNode } from 'react'
import { useTapesStore } from '@renderer/store/tapes'
import { useSettingsStore } from '@renderer/store/settings'
import { useToastStore } from '@renderer/store/toast'
import {
  useBinariesStore,
  binariesWithUpdate,
  updatesChecked,
} from '@renderer/store/binaries'
import { summarizeActivity } from '@renderer/lib/activity'
import { formatSpeed, formatTime } from '@renderer/lib/format'
import { Spinner } from '@renderer/components/ui'

/**
 * Footer split into three fixed zones, each owning one kind of information so
 * none evicts another:
 *   left   — live download activity, or an idle library summary
 *   center — the transient notice (import results, errors); empty when none
 *   right  — managed-tool / update state, click-through to the tools modal
 */
export function StatusBar() {
  return (
    <footer className="flex shrink-0 items-center gap-4 border-t border-zinc-700 px-4 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <ActivityZone />
      </div>
      <div className="min-w-0 flex-1 text-center">
        <NoticeZone />
      </div>
      <div className="flex min-w-0 flex-1 justify-end">
        <ToolsZone />
      </div>
    </footer>
  )
}

/**
 * The live pulse. Priority: active downloads (with summed speed + ETA) > a
 * waiting queue (amber when auto-start is off, since nothing will move until the
 * user acts) > an idle library count. A non-zero failed count trails in amber
 * regardless, so tapes needing attention are always visible.
 */
function ActivityZone() {
  const tapes = useTapesStore((s) => s.tapes)
  const progress = useTapesStore((s) => s.progress)
  const autoStart = useSettingsStore((s) => s.settings?.autoStartDownloads ?? true)

  const { downloading, queued, failed, totalSpeedBps, etaSec } = summarizeActivity(tapes, progress)

  let text: string
  let tone: string
  if (downloading > 0) {
    const parts = [`↓ ${downloading} downloading`]
    if (queued > 0) parts.push(`${queued} queued`)
    if (totalSpeedBps > 0) parts.push(formatSpeed(totalSpeedBps))
    if (etaSec != null) parts.push(`~${formatTime(etaSec)} left`)
    text = parts.join(' · ')
    tone = 'text-sky-300'
  } else if (queued > 0) {
    text = autoStart ? `${queued} queued` : `Paused · ${queued} waiting`
    tone = autoStart ? 'text-teal-300' : 'text-amber-300'
  } else {
    text = tapes.length === 0 ? 'No tapes yet' : `${tapes.length} ${tapes.length === 1 ? 'tape' : 'tapes'}`
    tone = 'text-zinc-300'
  }

  // Spin while work is actually moving (downloading, or queued with auto-start on
  // so it will move); a paused/idle bar stays still.
  const active = downloading > 0 || (queued > 0 && autoStart)

  return (
    <span className="flex items-center gap-1.5 truncate">
      {active && <Spinner className={tone} />}
      <span className={tone}>{text}</span>
      {failed > 0 && <span className="text-red-300"> · {failed} failed</span>}
    </span>
  )
}

/**
 * Passing info confirmations (replaces native alert()); empty when there's
 * nothing to say. Errors don't appear here — they float as dismissible cards
 * (see Toaster) so they can't scroll away before being read.
 */
function NoticeZone() {
  const info = useToastStore((s) => s.toasts).filter((t) => t.kind === 'info').at(-1)
  if (!info) return null
  return <span className="block truncate text-zinc-300">{info.text}</span>
}

/**
 * Managed-binary state. Actionable states (something missing, an update waiting)
 * open the tools modal on click; purely informational states stay plain text.
 * "Updates not checked" covers both auto-check being off and a check that failed.
 */
function ToolsZone() {
  const statuses = useBinariesStore((s) => s.statuses)
  const checking = useBinariesStore((s) => s.checking)
  const openModal = useBinariesStore((s) => s.openModal)

  const loaded = statuses.length > 0
  const missing = statuses.filter((s) => s.installedVersion === null).length
  const updates = binariesWithUpdate(statuses).length

  if (!loaded) return <Busy>Loading…</Busy>
  if (missing > 0) {
    return (
      <Action onClick={openModal} className="text-amber-300">
        {missing} {missing === 1 ? 'tool isn’t' : 'tools aren’t'} installed
      </Action>
    )
  }
  if (checking) return <Busy>Checking for updates…</Busy>
  if (updates > 0) {
    return (
      <Action onClick={openModal} className="text-sky-300">
        {updates} {updates === 1 ? 'update' : 'updates'} available
      </Action>
    )
  }
  if (updatesChecked(statuses)) return <Plain>Tools up to date</Plain>
  return <Plain>Updates not checked</Plain>
}

function Plain({ children }: { children: ReactNode }) {
  return <span className="block truncate text-zinc-300">{children}</span>
}

/** A still status with a spinner, for genuinely in-progress tool states. */
function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center justify-end gap-1.5 truncate text-zinc-300">
      <Spinner /> {children}
    </span>
  )
}

function Action({
  onClick,
  className,
  children,
}: {
  onClick: () => void
  className: string
  children: ReactNode
}) {
  return (
    <button onClick={onClick} className={`block truncate hover:underline ${className}`}>
      {children}
    </button>
  )
}
