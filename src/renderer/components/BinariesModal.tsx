import { useState } from 'react'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import type { DependencyState, DerivedStatus } from '@shared/binary-status'
import { ipcInvoke } from '@renderer/ipc/client'
import { useBinariesStore, derivedOf } from '@renderer/store/binaries'
import { useSettingsStore } from '@renderer/store/settings'
import { ROLE_TEXT_CLASS } from '@renderer/lib/status-role'
import { Modal } from '@renderer/components/Modal'
import { Button, Spinner, Toggle } from '@renderer/components/ui'

/**
 * The management surface for yt-dlp / ffmpeg / Deno (managed-runtime-dependencies-
 * conventions): the one place the full per-tool state lives and the only place
 * operations start. Each row derives its four-state status through the shared
 * deriveStatus and shows the version facts, live progress, and a single
 * context-aware action — Install when missing, Update when a newer version is
 * known, nothing otherwise. Operations run concurrently so other rows stay
 * interactive while one is in flight.
 *
 * The footer carries only a Close button. The modal does NOT auto-check on open —
 * checks happen at launch (gated, skipped within 24h) or via the Check button
 * below — so a user inspecting state never triggers a rate-limited network call.
 */
export function BinariesModal() {
  const statuses = useBinariesStore((s) => s.statuses)
  const progress = useBinariesStore((s) => s.progress)
  const checking = useBinariesStore((s) => s.checking)
  const setStatuses = useBinariesStore((s) => s.setStatuses)
  const setChecking = useBinariesStore((s) => s.setChecking)
  const closeModal = useBinariesStore((s) => s.closeModal)
  const settings = useSettingsStore((s) => s.settings)
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState<BinaryName[]>([])

  const checkUpdatesAtLaunch = settings?.checkUpdatesAtLaunch ?? true

  // Persist the one gate: whether to check for tool updates at launch. Nothing
  // auto-downloads — every install/update is the per-row action below.
  async function saveGate(check: boolean) {
    setError(null)
    try {
      const next = await ipcInvoke('settings:update', { checkUpdatesAtLaunch: check })
      useSettingsStore.getState().setSettings(next)
    } catch (err) {
      setError(String(err))
    }
  }

  // A binary is busy from the moment we launch an operation until it resolves (it
  // reports live progress in between). Other binaries stay free to act.
  const isWorking = (name: BinaryName) => launching.includes(name) || progress[name] !== undefined

  // Install / Update are the same acquire operation (download + verify + publish);
  // the state it starts from differs, the action is the same.
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
    <Modal
      title="Required tools"
      onClose={closeModal}
      size="2xl"
      fitContent
      footer={
        <Button variant="ghost" onClick={closeModal}>
          Close
        </Button>
      }
    >
      <p className="text-sm text-zinc-300">
        yt-dlp downloads media and ffmpeg processes it; Deno is the JavaScript runtime
        yt-dlp uses for sites that need it.
      </p>

      <div className="mt-5">
        <Toggle
          label="Check for tool updates on launch"
          description="Look for newer yt-dlp, ffmpeg, and Deno releases once when TapeBox launches."
          checked={checkUpdatesAtLaunch}
          onChange={(v) => void saveGate(v)}
        />
      </div>

      <div className="mt-5 flex items-center justify-between text-xs text-zinc-300">
        <span>{lastCheckedHint(statuses, checking)}</span>
        <Button variant="secondary" size="sm" onClick={() => void refresh()} loading={checking}>
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>

      {/* Fixed layout with explicit widths so the three data columns spread evenly
          instead of bunching at the left and leaving a gap before the action. */}
      <table className="mt-5 w-full table-fixed text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-zinc-300">
            <th className="w-1/4 pb-3">Tool</th>
            <th className="w-1/4 pb-3">Installed</th>
            <th className="w-1/4 pb-3">Latest</th>
            <th className="w-1/4 pb-3" />
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
              onInstall={() => void install(s.name)}
            />
          ))}
        </tbody>
      </table>

      {error && (
        <p className="mt-5 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
    </Modal>
  )
}

function BinaryRow({
  status,
  progress,
  pending,
  checking,
  onInstall,
}: {
  status: BinaryStatus
  progress: { percent: number; phase: string } | undefined
  pending: boolean
  checking: boolean
  onInstall: () => void
}) {
  const d = derivedOf(status)
  const label = acquireLabel(d.state)

  return (
    <tr className="border-t border-zinc-700">
      <td className="py-3 font-medium">{status.name}</td>
      <td className={`py-3 ${installedClass(d)}`}>{installedText(status, d)}</td>
      <td className="py-3 text-zinc-300">{latestText(status, d, checking)}</td>
      <td className="py-3 text-right">
        {progress ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
            <Spinner />
            {progress.phase} {progress.percent}%
          </span>
        ) : pending ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
            <Spinner />
            working…
          </span>
        ) : label ? (
          <Button variant="warm" size="sm" onClick={onInstall}>
            {label}
          </Button>
        ) : null}
      </td>
    </tr>
  )
}

/** The installed-version cell text. */
function installedText(status: BinaryStatus, d: DerivedStatus): string {
  if (d.state === 'not-installed') return 'not installed'
  return status.installedVersion ?? 'installed'
}

/** Colour the installed cell by role so a to-do reads as amber at a glance. */
function installedClass(d: DerivedStatus): string {
  return d.role === 'warning' ? ROLE_TEXT_CLASS.warning : 'text-zinc-300'
}

/** The latest-version cell text; distinguishes an unchecked tool from a known latest. */
function latestText(status: BinaryStatus, d: DerivedStatus, checking: boolean): string {
  if (checking) return 'checking…'
  if (d.state === 'installed-unchecked') return 'not checked'
  return status.latestKnownVersion ?? '—'
}

/** The one per-row action, or null when there is nothing to do (up to date, or a
 *  present copy with no known update). */
function acquireLabel(state: DependencyState): string | null {
  if (state === 'not-installed') return 'Install'
  if (state === 'update-available') return 'Update'
  return null
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
