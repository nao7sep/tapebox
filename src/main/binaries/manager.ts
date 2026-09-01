import { access, chmod, constants, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { binaryPath, ensureDirs, paths } from '@main/paths'
import { log } from '@main/io/logger'
import { emit } from '@main/ipc/events'
import { getDependencies, mutateDependencies } from '@main/store/dependencies'
import { execCapture } from '@main/io/spawn'
import { writeFileAtomicVia } from '@main/io/atomic-file'
import { describeError, errorMessage } from '@shared/error'
import { nowUtcIso } from '@shared/utc'
import { recordLatest } from '@shared/binary-status'
import { withRetry } from '@main/io/retry'
import {
  BINARY_DOWNLOAD_IDLE_TIMEOUT_MS,
  BINARY_ACQUIRE_TIMEOUT_MS,
  HTTP_RETRY,
  isRetryableHttpFailure,
} from '@main/io/network'
import type {
  BinaryCancelResult,
  BinaryCheckFailure,
  BinaryCheckResult,
  BinaryName,
  BinaryStatus,
  BinaryUpdateResult,
} from '@shared/ipc-contract'
import { binaryNames, binarySpecs } from './registry'
import {
  forgetInstalledVersion,
  readInstalledVersion,
  writeVersionSidecar,
} from './installed-version'
import { downloadWithProgress } from './http'
import { extractFileFromZip } from './archive'
import { verifyBinaryIntegrity } from './integrity'
import { assertArm64Slice } from './arch'

/**
 * Per-binary install / update orchestration.
 *
 * Layout on disk:
 *   ~/.tapebox/bin/{name}{ext}              -- the installed executable
 *   ~/.tapebox/bin/{name}.json               -- its version sidecar, where the binary can't self-report
 *   ~/.tapebox/temp/{name}-{nanoid}.partial  -- disposable download staging (cleared on launch)
 *
 * Install is atomic and crash-durable: download to a temp file, then prepare the
 * executable at a staging file (extract or move, then chmod) and publish it with
 * one fsync'd rename (writeFileAtomicVia) — so the file at bin/ only ever appears
 * complete, executable, and flushed, never mid-extract or pre-chmod.
 * Concurrent installOrUpdate for the same name is serialized by the in-flight map,
 * which also owns that operation's cancellation controller.
 *
 * Update-check policy: dependencies.<name>.{latestKnownVersion,
 * lastCheckedAtUtc} are the single source of truth — there's no in-memory
 * cache. The modal renders what's persisted; a fresh upstream lookup happens
 * only on startup (gated by checkUpdatesAtLaunch) or via an explicit user
 * action. This keeps GitHub API hits well under the unauthenticated rate
 * limit.
 *
 * The INSTALLED version is not among those facts: it is read back from the binary
 * itself (installed-version.ts), so it cannot drift from what is on disk. An
 * install therefore records only what it learned about upstream, and drops the
 * cached read so the next status sees the binary it just published.
 */

type ActiveInstall = {
  operationId: string
  controller: AbortController
  settled: Promise<void>
  settle: () => void
}

const inFlight = new Map<BinaryName, ActiveInstall>()
let shuttingDown = false
const FINAL_PREP_TIMEOUT_MS = 5_000

class BinaryOperationUnavailableError extends Error {}

/**
 * Serialize operations per binary (the convention's per-dependency rule): a second
 * install/update on the same binary is rejected rather than racing the first.
 */
async function withBinaryLock<T>(
  name: BinaryName,
  operationId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (shuttingDown) {
    throw new BinaryOperationUnavailableError('TapeBox is shutting down')
  }
  if (inFlight.has(name)) {
    throw new BinaryOperationUnavailableError(`${name} operation already in progress`)
  }
  const controller = new AbortController()
  let settle!: () => void
  const settled = new Promise<void>((resolve) => { settle = resolve })
  const active = { operationId, controller, settled, settle }
  inFlight.set(name, active)
  try {
    return await run(controller.signal)
  } finally {
    if (inFlight.get(name) === active) inFlight.delete(name)
    active.settle()
  }
}

/** Abort one user-started install/update. The original update IPC remains the
 * owner of settling and reporting the operation; this only delivers intent. */
export function cancelInstall(name: BinaryName, operationId: string): BinaryCancelResult {
  const active = inFlight.get(name)
  if (!active || active.operationId !== operationId) return { outcome: 'not-running' }
  active.controller.abort(new DOMException(`${name} install cancelled`, 'AbortError'))
  return { outcome: 'cancel-requested' }
}

/** Cancel and join every application-owned acquisition before stores and logging
 * shut down. The workers own staging cleanup; waiting for their settlement keeps
 * quit from abandoning a partially prepared artifact or deleting temp underneath
 * still-running work. */
export async function shutdownInstalls(): Promise<void> {
  shuttingDown = true
  const active = [...inFlight.values()]
  for (const operation of active) {
    if (!operation.controller.signal.aborted) {
      operation.controller.abort(new DOMException('TapeBox is shutting down', 'AbortError'))
    }
  }
  await Promise.all(active.map((operation) => operation.settled))
}

/**
 * The `<name>-<nanoid>.partial` download-staging filename inside paths.temp —
 * `<stem>-<discriminator>.<role-extension>` per the derived-sibling-name
 * convention. nanoid(10) is the discriminator, matching the app's other
 * derived-name sites (atomic-file.ts, rename-plan.ts): never a raw Date.now()
 * epoch, which two installs started in the same millisecond could collide on.
 * Pulled out of performInstall so the shape is assertable without driving a
 * full install.
 */
export function downloadTempPath(name: BinaryName): string {
  return join(paths.temp, `${name}-${nanoid(10)}.partial`)
}

async function isInstalled(name: BinaryName): Promise<boolean> {
  try {
    await access(binaryPath(name), constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Assemble the facts for one binary: the persisted network facts (last-known
// latest, last successful check) plus the two read from the artifact — presence
// from a filesystem scan, and the installed version from the binary itself, cached
// per process. Both artifact reads happen here, in an async handler, never on a
// render path. The renderer derives lifecycle/currency/role from these via the
// shared deriveStatus — main gathers facts, it does not pre-derive state.
//
// An absent binary is not read for a version: there is nothing to read, and
// skipping the call is what lets a binary that appears later be read on sight.
async function getStatus(name: BinaryName): Promise<BinaryStatus> {
  const entry = getDependencies()[name]
  const present = await isInstalled(name)
  return {
    name,
    present,
    installedVersion: present ? await readInstalledVersion(name) : null,
    latestKnownVersion: entry.latestKnownVersion,
    lastCheckedAtUtc: entry.lastCheckedAtUtc,
  }
}

export async function getAllStatuses(): Promise<BinaryStatus[]> {
  return Promise.all(binaryNames.map(getStatus))
}

/**
 * Resolve the latest upstream version of every binary. A success records that
 * binary's latestKnownVersion + lastCheckedAtUtc; a failure (network down, an
 * unparseable version, ffmpeg on Linux) writes **nothing** for that binary — no
 * version, no timestamp — so the displayed state stays at its last successful
 * knowledge (the convention's honest-state rule). Failures are logged, never
 * persisted, so there is no "check-failed" state to represent.
 */
export async function checkForUpdates(signal?: AbortSignal): Promise<BinaryCheckResult> {
  const now = nowUtcIso()
  const resolved = new Map<BinaryName, string>()
  const failures: BinaryCheckFailure[] = []

  await Promise.all(
    binaryNames.map(async (name) => {
      try {
        const asset = await binarySpecs[name].resolveLatest(signal)
        resolved.set(name, asset.version)
      } catch (err) {
        if (signal?.aborted) throw signal.reason
        // A failed check writes NOTHING (managed-runtime-dependencies-conventions):
        // no version, no timestamp, no error state — the displayed wording stays at
        // the last successful knowledge. Log it and move on.
        failures.push({ name, message: errorMessage(err) })
        log.warn('binary update check failed', { name, error: describeError(err) })
      }
    }),
  )

  log.info('binary update check complete', { resolved: resolved.size, failed: failures.length })
  // Apply inside the dependencies critical section: read the *current* entry (so a
  // concurrent install's fields are preserved) and fold in each successful check.
  await mutateDependencies((d) => {
    const next = { ...d }
    for (const [name, version] of resolved) {
      next[name] = recordLatest(d[name], version, now)
    }
    return next
  })
  return { outcome: 'completed', statuses: await getAllStatuses(), failures }
}

export async function installOrUpdate(
  name: BinaryName,
  operationId: string,
): Promise<BinaryUpdateResult> {
  try {
    return await withBinaryLock(name, operationId, async (cancelSignal) => {
      const signal = AbortSignal.any([
        cancelSignal,
        AbortSignal.timeout(BINARY_ACQUIRE_TIMEOUT_MS),
      ])
      let outcome: 'installed' | 'cancelled' | 'failed' = 'installed'
      let failure = ''
      try {
        await performInstall(name, operationId, signal)
      } catch (err) {
        // Only this operation's own controller can classify a cancellation. Network
        // TimeoutError also says "aborted" but leaves this signal live, so it remains
        // a real failure and reaches the UI.
        if (cancelSignal.aborted) {
          outcome = 'cancelled'
        } else {
          outcome = 'failed'
          failure = errorMessage(err)
          log.warn('binary install failed', { name, operationId, error: describeError(err) })
        }
      }

      // The terminal payload owns the post-operation truth. In particular, a
      // failure after publication can report present + version-unreadable rather
      // than leaving the renderer's pre-operation Not installed snapshot in place.
      const status = await getStatus(name)
      if (outcome === 'failed') {
        return { outcome, operationId, status, error: failure }
      }
      return { outcome, operationId, status }
    })
  } catch (err) {
    if (!(err instanceof BinaryOperationUnavailableError)) throw err
    // A second renderer or an unexpected caller can still race the per-tool claim.
    // It receives a correlated terminal result and current facts; it never creates
    // an unowned rejected promise in the management view.
    const error = errorMessage(err)
    log.warn('binary install request refused', { name, operationId, error: describeError(err) })
    return { outcome: 'failed', operationId, status: await getStatus(name), error }
  }
}

async function performInstall(
  name: BinaryName,
  operationId: string,
  signal: AbortSignal,
): Promise<void> {
  log.info('binary install start', { name, operationId })
  emit('binaries:progress', { name, operationId, percent: 0, phase: 'download' })

  const spec = binarySpecs[name]
  const resolved = await spec.resolveLatest(signal)
  signal.throwIfAborted()
  log.info('binary resolved', { name, version: resolved.version, url: resolved.downloadUrl })

  await ensureDirs()
  const downloadTemp = downloadTempPath(name)

  let lastEmittedPct = -1
  try {
    // not recorded: this .partial is disposable staging for a re-fetchable native
    // binary or its archive, not user-authored text. The completed executable has
    // the same exclusion below when it is atomically published into bin/.
    await withRetry(
      HTTP_RETRY,
      () =>
        downloadWithProgress({
          url: resolved.downloadUrl,
          destPath: downloadTemp,
          idleTimeoutMs: BINARY_DOWNLOAD_IDLE_TIMEOUT_MS,
          maxBytes: resolved.maxDownloadBytes,
          signal,
          onProgress: (received, total) => {
            const pct = total > 0 ? Math.floor((received / total) * 100) : 0
            if (pct !== lastEmittedPct) {
              lastEmittedPct = pct
              emit('binaries:progress', { name, operationId, percent: pct, phase: 'download' })
            }
          },
        }),
      { signal, isRetryable: isRetryableHttpFailure },
    )

    const finalPath = binaryPath(name)
    emit('binaries:progress', { name, operationId, percent: 0, phase: 'verify' })
    // Integrity gate: verify the downloaded bytes against the vendor's published
    // SHA-256 sums file before making them executable. A failure throws and aborts
    // the install (the temp is cleaned in the finally below). Every registered
    // source is required to provide this evidence; resolution refuses one that does not.
    const integrity = await verifyBinaryIntegrity(downloadTemp, resolved.integrity, signal)
    log.info('binary integrity verified', { name, method: integrity.method })
    signal.throwIfAborted()

    emit('binaries:progress', { name, operationId, percent: 0, phase: 'install' })

    // Prepare the complete, executable binary at a staging file, then publish it
    // with one atomic fsync'd rename. The chmod/de-quarantine happen on the stage
    // BEFORE it becomes finalPath, so a concurrent status check or a crash can
    // never catch the binary present-but-not-yet-runnable.
    // not recorded: this is a native binary (yt-dlp/ffmpeg/deno), re-fetchable and not
    // hand-authored text — a binary write that never calls the backup hook (data-backup
    // conventions). It uses the raw writeFileAtomicVia primitive, not the choke point.
    await writeFileAtomicVia(
      finalPath,
      async (stage) => {
        if (resolved.archive) {
          await extractFileFromZip(
            downloadTemp,
            resolved.archive.innerName,
            stage,
            resolved.maxInstalledBytes,
            signal,
          )
        } else {
          await rename(downloadTemp, stage)
        }
        signal.throwIfAborted()
        if (process.platform !== 'win32') {
          await chmod(stage, 0o755)
          // Strip macOS Gatekeeper quarantine if present; harmless when absent.
          if (process.platform === 'darwin') {
            const xattrSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(FINAL_PREP_TIMEOUT_MS),
            ])
            try {
              await execCapture('xattr', ['-d', 'com.apple.quarantine', stage], {
                reject: false,
                signal: xattrSignal,
                idleTimeoutMs: FINAL_PREP_TIMEOUT_MS,
              })
            } catch {
              // A missing attribute is harmless, but caller cancellation is not.
              signal.throwIfAborted()
            }
          }
        }
        // Architecture gate (macOS): reject an x86_64-only build before it is
        // published, so a wrong-arch download fails clean here rather than at exec
        // time on Apple Silicon (no Rosetta). A universal binary passes.
        if (process.platform === 'darwin') {
          await assertArm64Slice(stage, signal)
        }
        signal.throwIfAborted()
      },
      undefined,
      signal,
    )
  } finally {
    await unlink(downloadTemp).catch(() => {})
  }

  // The binary has landed. Where it cannot report its own version, record the
  // resolved one beside it — after the publish, so a failure here leaves a present
  // binary reading version-unknown (offering a re-acquire) rather than an old
  // binary wearing the new version's label.
  try {
    if (spec.installedVersion.kind === 'sidecar') {
      await writeVersionSidecar(name, resolved.version)
    }
  } finally {
    // Drop the cached read even when the sidecar write fails: the artifact
    // changed, and the next status must read the disk truth, not the
    // pre-install answer.
    forgetInstalledVersion(name)
  }

  log.info('binary installed', { name, version: resolved.version, integrityVerified: true })

  // Only the upstream fact is persisted. What is now installed is read back from
  // the binary, so an install has nothing to record about it.
  await mutateDependencies((d) => ({
    [name]: recordLatest(d[name], resolved.version, nowUtcIso()),
  }))

}
