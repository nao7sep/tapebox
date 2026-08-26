import { useState } from 'react'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import type { DependencyState, DerivedStatus } from '@shared/binary-status'
import { ipcInvoke } from '@renderer/ipc/client'
import {
  applyBinaryCheckResult,
  useBinariesStore,
  derivedOf,
} from '@renderer/store/binaries'
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
 * known or when the installed one could not be read, nothing otherwise.
 * Operations run concurrently so other rows stay interactive while one is in
 * flight.
 *
 * The footer carries only a Close button. The modal does NOT auto-check on open —
 * checks happen at launch (gated, skipped within 24h) or via the Check button
 * below — so a user inspecting state never triggers a rate-limited network call.
 */
export function BinariesModal() {
  const statuses = useBinariesStore((s) => s.statuses)
  const progress = useBinariesStore((s) => s.progress)
  const checking = useBinariesStore((s) => s.checking)
  const checkFailures = useBinariesStore((s) => s.checkFailures)
  const clearProgress = useBinariesStore((s) => s.clearProgress)
  const setChecking = useBinariesStore((s) => s.setChecking)
  const setCheckFailures = useBinariesStore((s) => s.setCheckFailures)
  const closeModal = useBinariesStore((s) => s.closeModal)
  const settings = useSettingsStore((s) => s.settings)
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState<BinaryName[]>([])
  const [cancelling, setCancelling] = useState<BinaryName[]>([])

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
      clearProgress(name)
      setLaunching((prev) => prev.filter((n) => n !== name))
      setCancelling((prev) => prev.filter((n) => n !== name))
    }
  }

  async function cancel(name: BinaryName) {
    if (cancelling.includes(name)) return
    setCancelling((prev) => [...prev, name])
    try {
      const result = await ipcInvoke('binaries:cancelUpdate', { name })
      if (result.outcome === 'not-running') {
        setCancelling((prev) => prev.filter((n) => n !== name))
      }
    } catch (err) {
      setCancelling((prev) => prev.filter((n) => n !== name))
      setError(String(err))
    }
  }

  async function refresh() {
    if (checking) return
    setError(null)
    setCheckFailures(null)
    setChecking(true)
    try {
      const result = await ipcInvoke('binaries:checkUpdates')
      applyBinaryCheckResult(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setChecking(false)
    }
  }

  async function cancelCheck() {
    try {
      await ipcInvoke('binaries:cancelCheck')
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <Modal
      title="Managed tools"
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
        <span>{lastCheckedHint(statuses, checking, checkFailures?.map((failure) => failure.name) ?? null)}</span>
        {checking ? (
          <Button variant="ghost" size="sm" onClick={() => void cancelCheck()}>Cancel check</Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>Check for updates</Button>
        )}
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
              cancelling={cancelling.includes(s.name)}
              checking={checking}
              onInstall={() => void install(s.name)}
              onCancel={() => void cancel(s.name)}
            />
          ))}
        </tbody>
      </table>

      {(error || (checkFailures && checkFailures.length > 0)) && (
        <p className="mt-5 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error ?? `Check incomplete — ${checkFailures!
            .map((failure) => `${failure.name}: ${failure.message}`)
            .join('; ')}`}
        </p>
      )}
    </Modal>
  )
}

function BinaryRow({
  status,
  progress,
  pending,
  cancelling,
  checking,
  onInstall,
  onCancel,
}: {
  status: BinaryStatus
  progress: { percent: number; phase: string } | undefined
  pending: boolean
  cancelling: boolean
  checking: boolean
  onInstall: () => void
  onCancel: () => void
}) {
  const d = derivedOf(status)
  const label = acquireLabel(d.state, status.installedVersion)

  return (
    <tr className="border-t border-zinc-700">
      <td className="py-3 font-medium">{status.name}</td>
      <td className={`py-3 ${installedClass(d)}`}>{installedText(status, d)}</td>
      <td className="py-3 text-zinc-300">{latestText(status, checking)}</td>
      <td className="py-3 text-right">
        {progress || pending ? (
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
              <Spinner />
              {cancelling
                ? 'Cancelling…'
                : progress
                  ? `${phaseLabel(progress.phase)} ${progress.percent}%`
                  : 'Working…'}
            </span>
            <Button variant="ghost" size="sm" disabled={cancelling} onClick={onCancel}>
              Cancel
            </Button>
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

/** The installed-version cell text. A present tool whose version could not be read
 *  says so — it is not absent, and it is not silently assumed current. */
function installedText(status: BinaryStatus, d: DerivedStatus): string {
  if (d.state === 'not-installed') return 'Not installed'
  return displayArtifactIdentity(status.installedVersion) ?? 'Version unreadable'
}

/** Colour the installed cell by role so a to-do reads as amber at a glance. */
function installedClass(d: DerivedStatus): string {
  return d.role === 'warning' ? ROLE_TEXT_CLASS.warning : 'text-zinc-300'
}

/** The latest-version cell text; distinguishes an unchecked tool from a known
 *  latest. Keyed off the fact itself rather than the state, because a tool can now
 *  be installed-unchecked WITH a successful check behind it — when the check
 *  landed but the installed version could not be read. */
function latestText(status: BinaryStatus, checking: boolean): string {
  if (checking) return 'Checking…'
  return displayArtifactIdentity(status.latestKnownVersion) ?? 'Not checked'
}

function displayArtifactIdentity(identity: string | null): string | null {
  return identity?.match(/^Latest Auto-Build \((.+)\)$/)?.[1] ?? identity
}

function phaseLabel(phase: string): string {
  return phase.length === 0 ? phase : phase[0].toUpperCase() + phase.slice(1)
}

/**
 * The one per-row action, or null when there is nothing to do. Install when the
 * tool is missing, Update when a newer version is known — and Update again when a
 * present tool's own version could not be read, which is the only way out of that
 * row: the set-wide Check resolves the LATEST, so it can never clear an unreadable
 * INSTALLED version, and re-acquiring is what replaces the copy that would not
 * answer. A present tool that simply hasn't been checked keeps its quiet row; the
 * Check button above is that one's action.
 */
function acquireLabel(state: DependencyState, installedVersion: string | null): string | null {
  if (state === 'not-installed') return 'Install'
  if (state === 'update-available') return 'Update'
  if (state === 'installed-unchecked' && installedVersion === null) return 'Update'
  return null
}

function lastCheckedHint(
  statuses: BinaryStatus[],
  checking: boolean,
  failedNames: BinaryName[] | null,
): string {
  if (checking) return 'Checking…'
  if (failedNames && failedNames.length > 0) {
    return `Check incomplete — ${failedNames.join(', ')} failed.`
  }
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
