import type { ReactNode } from 'react'
import { useTapesStore } from '@renderer/store/tapes'
import { useSettingsStore } from '@renderer/store/settings'
import { useToastStore } from '@renderer/store/toast'
import { useBinariesStore, summarizeBinaries } from '@renderer/store/binaries'
import { ROLE_TEXT_CLASS } from '@renderer/lib/status-role'
import { summarizeActivity } from '@renderer/lib/activity'
import { formatTime } from '@renderer/lib/format'
import { Spinner } from '@renderer/components/ui'
import { ArrowDownIcon } from './Icon'
import { useI18n } from '@renderer/i18n/I18nContext'
import { joinMessages, message, type Message, type MessageValue } from '@shared/i18n/translate'

/**
 * Footer split into three fixed zones, each owning one kind of information so
 * none evicts another:
 *   left   — live download activity, or an idle library summary
 *   center — an eligible app-wide passing notice; empty when none
 *   right  — managed-tool / update state, click-through to the tools modal
 */
export function StatusBar() {
  return (
    <footer className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-1.5 text-xs">
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
 * The live pulse, read left to right in pipeline order. The lead reflects the
 * most active stage with anything in it: active downloads (with summed speed +
 * ETA) > a working queue > tapes paused waiting for the user > an idle library
 * count. Then the attention items trail in a fixed order — failed, then pages to
 * scan — because they no longer jump the list, so this bar is where you spot them.
 */
function ActivityZone() {
  const tapes = useTapesStore((s) => s.tapes)
  const progress = useTapesStore((s) => s.progress)
  const autoStart = useSettingsStore((s) => s.settings?.autoStartDownloads ?? true)
  const t = useI18n()

  const { downloading, queued, paused, failed, listing, totalSpeedBps, etaSec } =
    summarizeActivity(tapes, progress)

  let text: Message
  let tone: string
  if (downloading > 0) {
    const rest: MessageValue[] = []
    if (queued > 0) rest.push(message('status.queued', { count: queued }))
    if (totalSpeedBps > 0) rest.push(t.bytesPerSecond(totalSpeedBps))
    if (etaSec != null) rest.push(message('status.timeLeft', { time: formatTime(etaSec) }))
    text = joinMessages(message('status.downloading', { count: downloading }), ...rest)
    tone = 'text-info-fg'
  } else if (queued > 0) {
    text = message('status.queued', { count: queued })
    tone = 'text-calm-fg'
  } else if (paused > 0) {
    // Paused tapes won't move until the user starts them — amber, like the chips.
    text = message('status.paused', { count: paused })
    tone = 'text-warning-fg'
  } else {
    text = tapes.length === 0 ? message('status.noTapes') : message('status.tapes', { count: tapes.length })
    tone = 'text-fg'
  }

  // Spin while work is actually moving (downloading, or queued with auto-start on
  // so it will move); a paused/idle bar stays still.
  const active = downloading > 0 || (queued > 0 && autoStart)

  return (
    <span className="flex items-center gap-1.5 truncate">
      {active && <Spinner className={tone} />}
      {downloading > 0 && <ArrowDownIcon className={tone} />}
      <span className={tone}>{t.text(text)}</span>
      {failed > 0 && <span className="text-danger-fg">{t.t('status.failedSuffix', { count: failed })}</span>}
      {listing > 0 && <span className="text-note-fg">{t.t('status.toScanSuffix', { count: listing })}</span>}
    </span>
  )
}

/**
 * Passing app-wide information; empty when there is nothing to say. Local
 * operation results stay with their owner, while eligible app-wide errors use
 * dismissible cards (see Toaster).
 */
function NoticeZone() {
  const info = useToastStore((s) => s.toasts).filter((toast) => toast.kind === 'info').at(-1)
  const t = useI18n()
  if (!info) return null
  return <span className="block truncate text-fg">{t.text(info.text)}</span>
}

/**
 * Managed-binary roll-up: the worst role across all tools, with the message and
 * click-through the shared summary decides. A missing or outdated tool shows in the
 * warning role (amber, actionable), a present-but-unchecked tool is a benign
 * "Updates not checked" (info), and a quiet (all up-to-date) set reads "Tools
 * ready". An operation in flight shows its transient progress, which sits above the
 * persisted roll-up.
 */
function ToolsZone() {
  const statuses = useBinariesStore((s) => s.statuses)
  const checking = useBinariesStore((s) => s.checking)
  const active = useBinariesStore((s) => s.active)
  const openModal = useBinariesStore((s) => s.openModal)
  const t = useI18n()

  if (statuses.length === 0) return <Busy>{t.t('common.loading')}</Busy>
  if (checking) return <Busy>{t.t('status.checkingTools')}</Busy>
  if (Object.keys(active).length > 0) return <Busy>{t.t('status.workingOnTools')}</Busy>

  const { role, text, actionable } = summarizeBinaries(statuses)
  if (role === 'none') return <Plain>{t.text(text)}</Plain>

  const cls = ROLE_TEXT_CLASS[role]
  if (actionable) return <Action onClick={openModal} className={cls}>{t.text(text)}</Action>
  return <span className={`block truncate ${cls}`}>{t.text(text)}</span>
}

function Plain({ children }: { children: ReactNode }) {
  return <span className="block truncate text-fg">{children}</span>
}

/** A still status with a spinner, for genuinely in-progress tool states. */
function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center justify-end gap-1.5 truncate text-fg">
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
