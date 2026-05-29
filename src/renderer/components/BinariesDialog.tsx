import { useEffect, useState } from 'react'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useBinariesStore } from '@renderer/store/binaries'
import { Dialog } from '@renderer/components/Dialog'

/**
 * Shared modal for installing and updating yt-dlp / ffmpeg / Deno. Each row's
 * action is derived from its state (missing / outdated / current), so the same
 * table serves first-run setup and later maintenance. Opening the modal kicks a
 * background update check; the Latest column shows "checking…" until it lands.
 */
type RowKind = 'missing' | 'update' | 'current' | 'installed-unknown'

function rowKind(s: BinaryStatus): RowKind {
  if (s.installedVersion === null) return 'missing'
  if (s.latestKnownVersion === null) return 'installed-unknown'
  if (s.latestKnownVersion !== s.installedVersion) return 'update'
  return 'current'
}

export function BinariesDialog() {
  const statuses = useBinariesStore((s) => s.statuses)
  const progress = useBinariesStore((s) => s.progress)
  const setStatuses = useBinariesStore((s) => s.setStatuses)
  const closeModal = useBinariesStore((s) => s.closeModal)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let alive = true
    setChecking(true)
    ipcInvoke('binaries:checkUpdates')
      .then((s) => alive && setStatuses(s))
      .catch((err) => alive && setError(String(err)))
      .finally(() => alive && setChecking(false))
    return () => {
      alive = false
    }
  }, [setStatuses])

  const actionable = statuses
    .filter((s) => rowKind(s) === 'missing' || rowKind(s) === 'update')
    .map((s) => s.name)

  async function install(names: BinaryName[]) {
    if (names.length === 0) return
    setInstalling(true)
    setError(null)
    try {
      await Promise.all(names.map((name) => ipcInvoke('binaries:update', { name })))
    } catch (err) {
      setError(String(err))
    } finally {
      setInstalling(false)
    }
  }

  const footer = (
    <>
      <button
        onClick={closeModal}
        disabled={installing}
        className="rounded px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
      >
        Close
      </button>
      <button
        onClick={() => void install(actionable)}
        disabled={installing || actionable.length === 0}
        className="rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 transition disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        {installing ? 'Working…' : 'Install all'}
      </button>
    </>
  )

  return (
    <Dialog title="TapeBox tools" onClose={closeModal} size="lg" closeDisabled={installing} footer={footer}>
      <p className="text-sm text-zinc-400">
        TapeBox uses yt-dlp, ffmpeg, and Deno to download and process media.
      </p>

      <table className="mt-5 w-full text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-zinc-500">
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
              checking={checking}
              busy={installing}
              onAction={() => void install([s.name])}
            />
          ))}
        </tbody>
      </table>

      {error && (
        <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
    </Dialog>
  )
}

function BinaryRow({
  status,
  progress,
  checking,
  busy,
  onAction,
}: {
  status: BinaryStatus
  progress: { percent: number; phase: string } | undefined
  checking: boolean
  busy: boolean
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
        ) : (
          <button
            onClick={onAction}
            disabled={busy}
            className={
              warm
                ? 'rounded bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50'
                : 'rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50'
            }
          >
            {actionLabel(kind)}
          </button>
        )}
      </td>
    </tr>
  )
}

function latestText(status: BinaryStatus, checking: boolean): string {
  if (status.latestKnownVersion !== null) return status.latestKnownVersion
  return checking ? 'checking…' : 'unavailable'
}

function actionLabel(kind: RowKind): string {
  if (kind === 'missing') return 'Install'
  if (kind === 'update') return 'Update'
  return 'Reinstall'
}
