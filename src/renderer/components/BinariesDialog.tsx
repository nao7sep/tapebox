import { useEffect, useState } from 'react'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import {
  useBinariesStore,
  allBinariesInstalled,
  binariesWithUpdate,
} from '@renderer/store/binaries'

/**
 * Shared modal for both first-time install and later updates. Each row's action
 * is derived from the binary's state (missing / up-to-date / update available),
 * so the same component serves the mandatory first-run flow and the optional
 * "manage tools" flow. `modalDismissible` (from the store) decides whether the
 * user can Skip; the mandatory first-run opens it non-dismissible.
 */
export function BinariesDialog() {
  const statuses = useBinariesStore((s) => s.statuses)
  const progress = useBinariesStore((s) => s.progress)
  const dismissible = useBinariesStore((s) => s.modalDismissible)
  const setStatuses = useBinariesStore((s) => s.setStatuses)
  const closeModal = useBinariesStore((s) => s.closeModal)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [checking, setChecking] = useState(false)

  const missing = statuses.filter((s) => s.installedVersion === null).map((s) => s.name)
  const updatable = binariesWithUpdate(statuses).map((s) => s.name)
  const actionable = [...new Set([...missing, ...updatable])]

  // A mandatory first-run modal closes itself once every tool is installed.
  useEffect(() => {
    if (!dismissible && allBinariesInstalled(statuses)) closeModal()
  }, [dismissible, statuses, closeModal])

  async function runActions(names: BinaryName[]) {
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

  async function checkForUpdates() {
    setChecking(true)
    setError(null)
    try {
      setStatuses(await ipcInvoke('binaries:checkUpdates'))
    } catch (err) {
      setError(String(err))
    } finally {
      setChecking(false)
    }
  }

  const busy = installing || checking
  const heading = missing.length > 0 ? 'Set up TapeBox' : 'TapeBox tools'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h2 className="text-lg font-medium">{heading}</h2>
        <p className="mt-2 text-sm text-zinc-400">
          TapeBox uses yt-dlp, ffmpeg, and Deno, installed in{' '}
          <code className="text-zinc-300">~/.tapebox/bin</code>.
        </p>

        <ul className="mt-5 space-y-3">
          {statuses.map((s) => (
            <BinaryRow key={s.name} status={s} progress={progress[s.name]} />
          ))}
        </ul>

        {error && (
          <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center gap-2">
          <button
            onClick={() => void runActions(actionable)}
            disabled={busy || actionable.length === 0}
            className="flex-1 rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 transition disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {primaryLabel({ installing, missing: missing.length, updatable: updatable.length })}
          </button>
          <button
            onClick={() => void checkForUpdates()}
            disabled={busy}
            className="rounded border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {dismissible && (
            <button
              onClick={closeModal}
              disabled={installing}
              className="rounded px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
            >
              {missing.length > 0 ? 'Skip' : 'Close'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function primaryLabel({
  installing,
  missing,
  updatable,
}: {
  installing: boolean
  missing: number
  updatable: number
}): string {
  if (installing) return 'Working…'
  if (missing > 0 && updatable > 0) return `Install & update ${missing + updatable}`
  if (missing > 0) return `Install ${missing} ${missing === 1 ? 'tool' : 'tools'}`
  if (updatable > 0) return `Update ${updatable}`
  return 'All set'
}

function BinaryRow({
  status,
  progress,
}: {
  status: BinaryStatus
  progress: { percent: number; phase: string } | undefined
}) {
  const installed = status.installedVersion !== null
  const updateAvailable =
    installed &&
    status.latestKnownVersion !== null &&
    status.latestKnownVersion !== status.installedVersion

  return (
    <li className="rounded border border-zinc-800 px-3 py-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{status.name}</div>
          <div className="text-xs text-zinc-500">{detail(status, progress, updateAvailable)}</div>
        </div>
        <div className="text-xs text-zinc-400">
          {progress ? `${progress.percent}%` : updateAvailable ? 'update' : installed ? '✓' : '—'}
        </div>
      </div>
      {progress && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div className="h-full bg-zinc-300 transition-all" style={{ width: `${progress.percent}%` }} />
        </div>
      )}
    </li>
  )
}

function detail(
  status: BinaryStatus,
  progress: { phase: string } | undefined,
  updateAvailable: boolean,
): string {
  if (progress) return `${progress.phase}…`
  if (status.installedVersion === null) return 'not installed'
  if (updateAvailable) return `${status.installedVersion} → ${status.latestKnownVersion}`
  return `installed: ${status.installedVersion}`
}
