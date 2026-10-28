import { Worker } from 'node:worker_threads'
import { paths } from '@main/paths'
import { log } from '@main/io/logger'
import { currentSession } from '@main/io/records'
import { describeError } from '@shared/error'
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
// Only the latest exact published bytes per waiting file survive supersession.
// Dispatch one clone at a time, rather than filling the worker message queue.
const waiting = new Map<string, Buffer>()
const drains = new Set<() => void>()

function settleDrains(): void {
  if (pending.size || waiting.size) return
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
  waiting.clear()
  settleDrains()
  log.warn('backup store: worker failed; unfinished record outcomes are unknown', { error: describeError(error) })
  void retire(current)
}

function ensureWorker(): Worker {
  if (worker) return worker
  const module = import.meta.url.endsWith('.ts') ? './backup-worker.ts' : './backup-worker.js'
  const created = new Worker(new URL(module, import.meta.url), {
    workerData: { databasePath: paths.backupsDb, session: launch ??= currentSession() ?? new Date().toISOString() } satisfies BackupWorkerData,
  })
  created.on('message', (response: BackupResponse) => {
    const entry = pending.get(response.id)
    if (!entry || entry.worker !== created) return
    pending.delete(response.id)
    if (response.disabled && worker === created) disabled = true
    if (response.warning) log.warn(response.warning.message, response.warning.fields)
    if (disabled) waiting.clear()
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
  const next = waiting.entries().next()
  if (next.done) return
  const [absolutePath, bytes] = next.value
  waiting.delete(absolutePath)
  let current: Worker
  try { current = ensureWorker() } catch (error) {
    disabled = true
    log.warn('backup store: worker could not start; recording disabled', { error: describeError(error) })
    waiting.clear()
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
  waiting.delete(absolutePath)
  waiting.set(absolutePath, bytes)
  dispatchNext()
}

export function flushBackupStore(): Promise<void> {
  if (!pending.size && !waiting.size) return Promise.resolve()
  return new Promise<void>((resolve) => { drains.add(resolve) })
}

export function closeBackupStore(): Promise<void> {
  if (closing) return closing
  accepting = false
  closing = (async () => {
    await flushBackupStore()
    const current = worker
    worker = null
    if (current) void retire(current)
    await Promise.all([...retirements.values()])
  })()
  return closing
}
