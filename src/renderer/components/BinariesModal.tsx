import { useState } from 'react'
import type { BinaryName, BinaryStatus } from '@shared/ipc-contract'
import type { DependencyState, DerivedStatus } from '@shared/binary-status'
import { ipcInvoke } from '@renderer/ipc/client'
import {
  useBinariesStore,
  derivedOf,
} from '@renderer/store/binaries'
import { useSettingsStore } from '@renderer/store/settings'
import { ROLE_TEXT_CLASS } from '@renderer/lib/status-role'
import { Modal } from '@renderer/components/Modal'
import { Button, InlineError, Spinner, Toggle } from '@renderer/components/ui'
import { presentFailure } from '@renderer/lib/presentFailure'
import { useI18n, type UiTranslator } from '@renderer/i18n/I18nContext'
import { message, type Message } from '@shared/i18n/translate'
import type { MessageKey } from '@shared/i18n/catalogues'

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
  const active = useBinariesStore((s) => s.active)
  const errors = useBinariesStore((s) => s.errors)
  const terminalOutcomes = useBinariesStore((s) => s.terminalOutcomes)
  const checking = useBinariesStore((s) => s.checking)
  const checkCancelling = useBinariesStore((s) => s.checkCancelling)
  const checkError = useBinariesStore((s) => s.checkError)
  const checkFailures = useBinariesStore((s) => s.checkFailures)
  const install = useBinariesStore((s) => s.install)
  const cancelInstall = useBinariesStore((s) => s.cancelInstall)
  const checkUpdates = useBinariesStore((s) => s.checkUpdates)
  const cancelCheck = useBinariesStore((s) => s.cancelCheck)
  const closeModal = useBinariesStore((s) => s.closeModal)
  const settings = useSettingsStore((s) => s.settings)
  const [settingsError, setSettingsError] = useState<Message | null>(null)
  const t = useI18n()

  const checkUpdatesAtLaunch = settings?.checkUpdatesAtLaunch ?? true

  // Persist the one gate: whether to check for tool updates at launch. Nothing
  // auto-downloads — every install/update is the per-row action below.
  async function saveGate(check: boolean) {
    setSettingsError(null)
    try {
      const { settings: next } = await ipcInvoke('settings:update', { checkUpdatesAtLaunch: check })
      useSettingsStore.getState().setSettings(next)
    } catch (err) {
      setSettingsError(presentFailure(err, message('tools.gateSaveFailed'), 'tool update setting save failed'))
    }
  }

  // One line per failed tool, each naming its tool through the same entry.
  const toolLines = (failures: Array<[string, Message]>) =>
    failures.map(([tool, reason]) => t.t('tools.toolReason', { tool, reason }))
  const acquisitionErrors = toolLines(Object.entries(errors) as Array<[string, Message]>)
  const visibleError = settingsError
    ? t.text(settingsError)
    : checkError
      ? t.text(checkError)
      : acquisitionErrors.length > 0 ? acquisitionErrors.join('\n') : null

  return (
    <Modal
      title={t.t('tools.title')}
      onClose={closeModal}
      size="2xl"
      fitContent
      footer={
        <Button variant="ghost" onClick={closeModal}>
          {t.t('common.close')}
        </Button>
      }
    >
      <p className="text-sm text-fg">
        {t.t('tools.intro')}
      </p>

      <div className="mt-5">
        <Toggle
          label={t.t('tools.checkOnLaunch')}
          description={t.t('tools.checkOnLaunchHint')}
          checked={checkUpdatesAtLaunch}
          onChange={(v) => void saveGate(v)}
        />
      </div>

      <div className="mt-5 flex items-center justify-between text-xs text-fg">
        <span>{lastCheckedHint(statuses, checking, checkFailures?.map((failure) => failure.name) ?? null, t)}</span>
        {checking ? (
          <Button variant="ghost" size="sm" disabled={checkCancelling} onClick={() => void cancelCheck()}>
            {t.t(checkCancelling ? 'tools.cancelling' : 'tools.cancelCheck')}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => void checkUpdates()}>{t.t('tools.checkForUpdates')}</Button>
        )}
      </div>

      {/* Fixed layout with explicit widths so the three data columns spread evenly
          instead of bunching at the left and leaving a gap before the action. */}
      <table className="mt-5 w-full table-fixed text-sm">
        <thead>
          <tr className="text-left text-xs font-medium text-fg">
            <th className="w-1/4 pb-3">{t.t('tools.columnTool')}</th>
            <th className="w-1/4 pb-3">{t.t('tools.columnInstalled')}</th>
            <th className="w-1/4 pb-3">{t.t('tools.columnLatest')}</th>
            <th className="w-1/4 pb-3" />
          </tr>
        </thead>
        <tbody>
          {statuses.map((s) => (
            <BinaryRow
              key={s.name}
              status={s}
              progress={progress[s.name]}
              pending={active[s.name] !== undefined}
              cancelling={active[s.name]?.cancelling === true}
              terminalOutcome={terminalOutcomes[s.name]}
              checking={checking}
              onInstall={() => void install(s.name)}
              onCancel={() => void cancelInstall(s.name)}
            />
          ))}
        </tbody>
      </table>

      {(visibleError || (checkFailures && checkFailures.length > 0)) && (
        <InlineError className="mt-5">
          {visibleError ?? t.t('tools.checkIncompleteDetail', {
            details: toolLines(checkFailures!.map((failure) => [failure.name, failure.message])).join('\n'),
          })}
        </InlineError>
      )}
    </Modal>
  )
}

function BinaryRow({
  status,
  progress,
  pending,
  cancelling,
  terminalOutcome,
  checking,
  onInstall,
  onCancel,
}: {
  status: BinaryStatus
  progress: { percent: number; phase: Phase } | undefined
  pending: boolean
  cancelling: boolean
  terminalOutcome: 'cancelled' | undefined
  checking: boolean
  onInstall: () => void
  onCancel: () => void
}) {
  const d = derivedOf(status)
  const label = acquireLabel(d.state, status.installedVersion)
  const t = useI18n()

  return (
    <tr className="border-t border-line">
      <td className="py-3 font-medium">{status.name}</td>
      <td className={`py-3 ${installedClass(d)}`}>{installedText(status, d, t)}</td>
      <td className="py-3 text-fg">{latestText(status, checking, t)}</td>
      <td className="py-3 text-right">
        {progress || pending ? (
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-fg">
              <Spinner />
              {cancelling
                ? t.t('tools.cancelling')
                : progress
                  ? t.t(PHASE_LABEL[progress.phase], { percent: progress.percent })
                  : t.t('common.working')}
            </span>
            <Button variant="ghost" size="sm" disabled={cancelling} onClick={onCancel}>
              {t.t('common.cancel')}
            </Button>
          </span>
        ) : label ? (
          <span className="inline-flex items-center gap-2">
            {terminalOutcome === 'cancelled' && (
              <span className="text-xs text-fg">{t.t('tools.cancelled')}</span>
            )}
            <Button variant="warm" size="sm" onClick={onInstall}>
              {t.t(label)}
            </Button>
          </span>
        ) : null}
      </td>
    </tr>
  )
}

/** The installed-version cell text. A present tool whose version could not be read
 *  says so — it is not absent, and it is not silently assumed current. */
function installedText(status: BinaryStatus, d: DerivedStatus, t: UiTranslator): string {
  if (d.state === 'not-installed') return t.t('tools.notInstalled')
  return displayArtifactIdentity(status.installedVersion) ?? t.t('tools.versionUnreadable')
}

/** Colour the installed cell by role so a to-do reads as amber at a glance. */
function installedClass(d: DerivedStatus): string {
  return d.role === 'warning' ? ROLE_TEXT_CLASS.warning : 'text-fg'
}

/** The latest-version cell text; distinguishes an unchecked tool from a known
 *  latest. Keyed off the fact itself rather than the state, because a tool can now
 *  be installed-unchecked WITH a successful check behind it — when the check
 *  landed but the installed version could not be read. */
function latestText(status: BinaryStatus, checking: boolean, t: UiTranslator): string {
  if (checking) return t.t('tools.checking')
  return displayArtifactIdentity(status.latestKnownVersion) ?? t.t('tools.notChecked')
}

function displayArtifactIdentity(identity: string | null): string | null {
  return identity?.match(/^Latest Auto-Build \((.+)\)$/)?.[1] ?? identity
}

type Phase = 'download' | 'verify' | 'install'

const PHASE_LABEL: Record<Phase, MessageKey> = {
  download: 'tools.phaseDownload',
  verify: 'tools.phaseVerify',
  install: 'tools.phaseInstall',
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
function acquireLabel(state: DependencyState, installedVersion: string | null): MessageKey | null {
  if (state === 'not-installed') return 'tools.install'
  if (state === 'update-available') return 'tools.update'
  if (state === 'installed-unchecked' && installedVersion === null) return 'tools.update'
  return null
}

function lastCheckedHint(
  statuses: BinaryStatus[],
  checking: boolean,
  failedNames: BinaryName[] | null,
  t: UiTranslator,
): string {
  if (checking) return t.t('tools.checking')
  if (failedNames && failedNames.length > 0) {
    return t.t('tools.checkIncomplete', { tools: t.list(failedNames), count: failedNames.length })
  }
  const timestamps = statuses.map((s) => s.lastCheckedAtUtc).filter((stamp): stamp is string => !!stamp)
  if (timestamps.length === 0) return t.t('tools.neverChecked')
  const latest = timestamps.sort().at(-1)!
  return t.t('tools.lastChecked', { when: relativeTime(latest, t) })
}

/** How long ago, in the reader's language ("now" under a minute). */
function relativeTime(utcIso: string, t: UiTranslator): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(utcIso)) / 1000))
  if (diffSec < 60) return t.relativeTime(0, 'second')
  if (diffSec < 3600) return t.relativeTime(Math.floor(diffSec / 60), 'minute')
  if (diffSec < 86400) return t.relativeTime(Math.floor(diffSec / 3600), 'hour')
  return t.relativeTime(Math.floor(diffSec / 86400), 'day')
}
