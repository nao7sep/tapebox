import { Worker } from 'node:worker_threads'
import { paths } from '@main/paths'
import { log } from '@main/io/logger'
import { APP_WRITER } from '@main/io/app-writer'
import { currentSession } from '@main/io/records'
import { describeError } from '@shared/error'
import type { RefusedFile } from '@main/io/store-access'
import type { BackupRequest, BackupResponse, BackupWorkerData } from './backup-worker'

/** This launch, the key of each file's one row per launch: the records' session,
 *  so the two can be matched, or failing that the time the first backup ran. */
let launch: string | null = null

/** Best-effort backup hashing and SQLite work run on their own thread.
 * Completed managed writes hand off their exact bytes; failures never undo them.
 * Local storage work has no deadline; only the exit sequence's one deadline
 * bounds its drain. */

type Pending = { worker: Worker }
let worker: Worker | null = null
let disabled = false
let accepting = true
let nextId = 1
let closing: Promise<void> | null = null
const pending = new Map<number, Pending>()
// Waiting backups in save order, each applied by the worker. Dispatch one clone
// at a time, rather than filling the worker message queue.
let waiting: Array<{ absolutePath: string; bytes: Buffer }> = []
const drains = new Set<() => void>()
// Startup's open check, answered by id; and the store's refusal once known.
const probes = new Map<number, (refused: RefusedFile | null) => void>()
let refusal: RefusedFile | null = null

function settleDrains(): void {
  if (pending.size || waiting.length) return
  for (const resolve of drains) resolve()
  drains.clear()
}
const retirements = new Map<Worker, Promise<void>>()

function retire(current: Worker): Promise<void> {
  const existing = retirements.get(current)
  if (existing) return existing
  const retirement = current.terminate().then(() => {}, (error: unknown) => {
    log.warn('backup store: worker did not retire cleanly', { error: describeError(error) })
  }).finally(() => { retirements.delete(current) })
  retirements.set(current, retirement)
  return retirement
}

function abandon(current: Worker, error: unknown): void {
  if (worker !== current && ![...pending.values()].some((entry) => entry.worker === current)) return
  if (worker === current) { worker = null; disabled = true }
  for (const [id, entry] of pending) if (entry.worker === current) pending.delete(id)
  waiting = []
  settleDrains()
  log.warn('backup store: worker failed; unfinished record outcomes are unknown', { error: describeError(error) })
  void retire(current)
}

function ensureWorker(): Worker {
  if (worker) return worker
  const module = import.meta.url.endsWith('.ts') ? './backup-worker.ts' : './backup-worker.js'
  const created = new Worker(new URL(module, import.meta.url), {
    workerData: { databasePath: paths.backupsDb, session: launch ??= currentSession() ?? new Date().toISOString(), writer: APP_WRITER } satisfies BackupWorkerData,
  })
  created.on('message', (response: BackupResponse) => {
    if (response.refused) refusal = { path: paths.backupsDb, reason: response.refused }
    if (response.disabled && worker === created) disabled = true
    const probe = probes.get(response.id)
    if (probe) {
      probes.delete(response.id)
      if (response.warning) log.warn(response.warning.message, response.warning.fields)
      probe(refusal)
      return
    }
    const entry = pending.get(response.id)
    if (!entry || entry.worker !== created) return
    pending.delete(response.id)
    if (response.disabled && worker === created) disabled = true
    if (response.warning) log.warn(response.warning.message, response.warning.fields)
    if (disabled) waiting = []
    dispatchNext()
    settleDrains()
  })
  created.on('error', (error: unknown) => abandon(created, error))
  created.on('exit', (code) => {
    if (worker === created) abandon(created, new Error(`Backup worker exited with code ${code}.`))
  })
  created.unref()
  worker = created
  return created
}

function dispatchNext(): void {
  if (disabled || pending.size) return
  const next = waiting.shift()
  if (!next) return
  const { absolutePath, bytes } = next
  let current: Worker
  try { current = ensureWorker() } catch (error) {
    disabled = true
    log.warn('backup store: worker could not start; recording disabled', { error: describeError(error) })
    waiting = []
    settleDrains()
    return
  }
  const id = nextId++
  pending.set(id, { worker: current })
  try { current.postMessage({ id, absolutePath, bytes } satisfies BackupRequest) }
  catch (error) { abandon(current, error) }
}

export function record(absolutePath: string, bytes: Buffer): void {
  if (!accepting || disabled) return
  waiting.push({ absolutePath, bytes })
  dispatchNext()
}

/**
 * Open the backup store at launch, before any save reaches it, and say whether
 * it was refused: newer or unreadable, it is left as it is and recording stays
 * off for this launch (store-recovery-conventions).
 */
export function openBackupStore(): Promise<RefusedFile | null> {
  if (disabled) return Promise.resolve(refusal)
  let current: Worker
  try { current = ensureWorker() } catch (error) {
    disabled = true
    log.warn('backup store: worker could not start; recording disabled', { error: describeError(error) })
    return Promise.resolve(null)
  }
  const id = nextId++
  return new Promise((resolve) => {
    probes.set(id, resolve)
    current.once('exit', () => { if (probes.delete(id)) resolve(refusal) })
    try { current.postMessage({ id } satisfies BackupRequest) } catch (error) {
      probes.delete(id)
      abandon(current, error)
      resolve(refusal)
    }
  })
}

export function flushBackupStore(): Promise<void> {
  if (!pending.size && !waiting.length) return Promise.resolve()
  return new Promise<void>((resolve) => { drains.add(resolve) })
}

/** Seals admission and stops the worker. With `drain` (ordinary quit) the
 * waiting backups are written first, within what remains of the exit deadline;
 * at OS session end they are skipped (data-backup-conventions). */
export function closeBackupStore({ drain = true }: { drain?: boolean } = {}): Promise<void> {
  if (closing) return closing
  accepting = false
  if (!drain) {
    waiting = []
    pending.clear()
  }
  closing = (async () => {
    await flushBackupStore()
    const current = worker
    worker = null
    if (current) void retire(current)
    await Promise.all([...retirements.values()])
  })()
  return closing
}
