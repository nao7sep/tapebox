import { useState } from 'react'
import type { BinaryStatus } from '@shared/ipc-contract'
import { ipcInvoke } from '@renderer/ipc/client'
import { useBinariesStore } from '@renderer/store/binaries'

/**
 * Blocks the main UI until yt-dlp, ffmpeg, and Deno are installed.
 * One "Install" button triggers all missing binaries in parallel.
 */
export function FirstRunDialog() {
  const statuses = useBinariesStore((s) => s.statuses)
  const progress = useBinariesStore((s) => s.progress)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const missing = statuses.filter((s) => s.installedVersion === null).map((s) => s.name)

  async function installAll() {
    setError(null)
    setRunning(true)
    try {
      await Promise.all(missing.map((name) => ipcInvoke('binaries:update', { name })))
    } catch (err) {
      setError(String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <h2 className="text-lg font-medium">Setting up TapeBox</h2>
        <p className="mt-2 text-sm text-zinc-400">
          TapeBox needs three tools to work. They&apos;ll be installed in <code className="text-zinc-300">~/.tapebox/bin</code>.
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

        <button
          onClick={installAll}
          disabled={running || missing.length === 0}
          className="mt-6 w-full rounded bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-950 transition disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {running ? 'Installing…' : missing.length === 0 ? 'All set' : `Install ${missing.length} ${missing.length === 1 ? 'tool' : 'tools'}`}
        </button>
      </div>
    </div>
  )
}

function BinaryRow({ status, progress }: { status: BinaryStatus; progress: { percent: number; phase: string } | undefined }) {
  const installed = status.installedVersion !== null
  return (
    <li className="rounded border border-zinc-800 px-3 py-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{status.name}</div>
          <div className="text-xs text-zinc-500">
            {installed
              ? `installed: ${status.installedVersion}`
              : progress
                ? `${progress.phase}…`
                : 'not installed'}
          </div>
        </div>
        <div className="text-xs text-zinc-400">
          {installed ? '✓' : progress ? `${progress.percent}%` : '—'}
        </div>
      </div>
      {!installed && progress && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-zinc-300 transition-all"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}
    </li>
  )
}

export function allBinariesInstalled(statuses: BinaryStatus[]): boolean {
  if (statuses.length === 0) return false
  return statuses.every((s) => s.installedVersion !== null)
}
