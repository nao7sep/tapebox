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
 *
 * Installs run concurrently: starting one row leaves every other row (and the
 * Close button) interactive, so the user can queue several at once.
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
  const checking = useBinariesStore((s) => s.checking)
  const setStatuses = useBinariesStore((s) => s.setStatuses)
  const setChecking = useBinariesStore((s) => s.setChecking)
  const closeModal = useBinariesStore((s) => s.closeModal)
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState<BinaryName[]>([])

  useEffect(() => {
    let alive = true
    setChecking(true)
    ipcInvoke('binaries:checkUpdates')
      .then((s) => alive && setStatuses(s))
      .catch((err) => alive && setError(String(err)))
      .finally(() => setChecking(false))
    return () => {
      alive = false
    }
  }, [setStatuses, setChecking])

  // A binary is busy from the moment we launch it until install resolves (it
  // reports live progress in between). Other binaries stay free to start.
  const isWorking = (name: BinaryName) => launching.includes(name) || progress[name] !== undefined

  const actionable = statuses
    .filter((s) => (rowKind(s) === 'missing' || rowKind(s) === 'update') && !isWorking(s.name))
    .map((s) => s.name)

  async function install(names: BinaryName[]) {
    const todo = names.filter((name) => !isWorking(name))
    if (todo.length === 0) return
    setError(null)
    setLaunching((prev) => [...prev, ...todo])
    await Promise.all(
      todo.map(async (name) => {
        try {
          await ipcInvoke('binaries:update', { name })
        } catch (err) {
          setError(String(err))
        } finally {
          setLaunching((prev) => prev.filter((n) => n !== name))
        }
      }),
    )
  }

  const footer = (
    <>
      <button onClick={closeModal} className="rounded px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100">
        Close
      </button>
      <button
        onClick={() => void install(actionable)}
        disabled={actionable.length === 0}
        className="rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 transition disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        Install all
      </button>
    </>
  )

  return (
    <Dialog title="Required tools" onClose={closeModal} size="xl" fitContent footer={footer}>
      <p className="text-sm text-zinc-400">
        yt-dlp, ffmpeg, and Deno handle downloading and media processing.
      </p>

      <table className="mt-5 w-full text-sm">
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
          <button
            onClick={onAction}
            className={
              warm
                ? 'rounded bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-amber-400'
                : 'rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800'
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
