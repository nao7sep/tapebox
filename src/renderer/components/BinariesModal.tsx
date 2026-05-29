import { useState } from 'react'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useBinariesStore } from '@renderer/store/binaries'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/ui'

/**
 * Tools modal for installing and updating yt-dlp / ffmpeg / Deno. Each row's
 * action is derived from its state (missing / outdated / current); installs run
 * concurrently so other rows stay interactive while one is in flight. There's
 * no footer — close via ✕ / Esc / backdrop — and no bulk button: with only
 * three rows, per-row actions are clearer than a "do everything" CTA.
 *
 * The modal does NOT auto-check on open. Update checks happen at startup
 * (gated by autoCheckBinaryUpdates and skipped if checked within 24h) or when
 * the user clicks Refresh below the intro. Keeps GitHub API hits well under
 * the unauthenticated rate limit.
 */
type RowKind = 'missing' | 'update' | 'current' | 'installed-unknown'

function rowKind(s: BinaryStatus): RowKind {
  if (s.installedVersion === null) return 'missing'
  if (s.latestKnownVersion === null) return 'installed-unknown'
  if (s.latestKnownVersion !== s.installedVersion) return 'update'
  return 'current'
}

export function BinariesModal() {
  const statuses = useBinariesStore((s) => s.statuses)
  const progress = useBinariesStore((s) => s.progress)
  const checking = useBinariesStore((s) => s.checking)
  const setStatuses = useBinariesStore((s) => s.setStatuses)
  const setChecking = useBinariesStore((s) => s.setChecking)
  const closeModal = useBinariesStore((s) => s.closeModal)
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState<BinaryName[]>([])

  // A binary is busy from the moment we launch it until install resolves (it
  // reports live progress in between). Other binaries stay free to start.
  const isWorking = (name: BinaryName) => launching.includes(name) || progress[name] !== undefined

  async function install(name: BinaryName) {
    if (isWorking(name)) return
    setError(null)
    setLaunching((prev) => [...prev, name])
    try {
      await ipcInvoke('binaries:update', { name })
    } catch (err) {
      setError(String(err))
    } finally {
      setLaunching((prev) => prev.filter((n) => n !== name))
    }
  }

  async function refresh() {
    if (checking) return
    setError(null)
    setChecking(true)
    try {
      setStatuses(await ipcInvoke('binaries:checkUpdates'))
    } catch (err) {
      setError(String(err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <Modal title="Required tools" onClose={closeModal} size="2xl" fitContent>
      <p className="text-sm text-zinc-400">
        yt-dlp, ffmpeg, and Deno handle downloading and media processing.
      </p>

      <div className="mt-4 flex items-center justify-between text-xs text-zinc-400">
        <span>{lastCheckedHint(statuses, checking)}</span>
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={checking}>
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-zinc-400">
            <th className="pb-2">Tool</th>
            <th className="pb-2">Installed</th>
            <th className="pb-2">Latest</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {statuses.map((s) => (
            <BinaryRow
              key={s.name}
              status={s}
              progress={progress[s.name]}
              pending={launching.includes(s.name)}
              checking={checking}
              onAction={() => void install(s.name)}
            />
          ))}
        </tbody>
      </table>

      {error && (
        <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
    </Modal>
  )
}

function BinaryRow({
  status,
  progress,
  pending,
  checking,
  onAction,
}: {
  status: BinaryStatus
  progress: { percent: number; phase: string } | undefined
  pending: boolean
  checking: boolean
  onAction: () => void
}) {
  const kind = rowKind(status)
  const warm = kind === 'missing' || kind === 'update'

  return (
    <tr className="border-t border-zinc-800">
      <td className="py-2 font-medium">{status.name}</td>
      <td className={`py-2 ${warm ? 'text-amber-300' : 'text-zinc-300'}`}>
        {status.installedVersion ?? 'not installed'}
      </td>
      <td className="py-2 text-zinc-400">{latestText(status, checking)}</td>
      <td className="py-2 text-right">
        {progress ? (
          <span className="text-xs text-zinc-400">
            {progress.phase} {progress.percent}%
          </span>
        ) : pending ? (
          <span className="text-xs text-zinc-400">starting…</span>
        ) : (
          <Button variant={warm ? 'warm' : 'secondary'} size="sm" onClick={onAction}>
            {actionLabel(kind)}
          </Button>
        )}
      </td>
    </tr>
  )
}

function latestText(status: BinaryStatus, checking: boolean): string {
  if (status.latestKnownVersion !== null) return status.latestKnownVersion
  return checking ? 'checking…' : 'unknown'
}

function actionLabel(kind: RowKind): string {
  if (kind === 'missing') return 'Install'
  if (kind === 'update') return 'Update'
  return 'Reinstall'
}

function lastCheckedHint(statuses: BinaryStatus[], checking: boolean): string {
  if (checking) return 'Checking…'
  const timestamps = statuses.map((s) => s.lastCheckedAtUtc).filter((t): t is string => !!t)
  if (timestamps.length === 0) return 'Never checked for updates.'
  const latest = timestamps.sort().at(-1)!
  return `Last checked ${relativeTime(latest)}.`
}

function relativeTime(utcIso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(utcIso)) / 1000))
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h ago`
  return `${Math.floor(diffSec / 86400)} days ago`
}
