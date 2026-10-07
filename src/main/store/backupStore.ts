import { Worker } from 'node:worker_threads'
import { paths } from '@main/paths'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import type { BackupRequest, BackupResponse } from './backup-worker'

/** Best-effort backup hashing and SQLite work run on their own bounded thread.
 * Completed managed writes hand off their exact bytes; failures never undo them. */
export const BACKUP_RECORD_TIMEOUT_MS = 10_000
const CLOSE_DRAIN_TIMEOUT_MS = 1_000
const TERMINAL_RECORD_TIMEOUT_MS = 500

type Pending = { worker: Worker; settled: Promise<void>; resolve: () => void; timer: NodeJS.Timeout }
let worker: Worker | null = null
let disabled = false
let accepting = true
let nextId = 1
let closing: Promise<void> | null = null
const pending = new Map<number, Pending>()
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
  for (const [id, entry] of pending) {
    if (entry.worker !== current) continue
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve()
  }
  log.warn('backup store: worker failed; unfinished record outcomes are unknown', { error: describeError(error) })
  void retire(current)
}

function ensureWorker(): Worker {
  if (worker) return worker
  const module = import.meta.url.endsWith('.ts') ? './backup-worker.ts' : './backup-worker.js'
  const created = new Worker(new URL(module, import.meta.url), { workerData: { databasePath: paths.backupsDb } })
  created.on('message', (response: BackupResponse) => {
    const entry = pending.get(response.id)
    if (!entry || entry.worker !== created) return
    pending.delete(response.id)
    clearTimeout(entry.timer)
    if (response.disabled && worker === created) disabled = true
    if (response.warning) log.warn(response.warning.message, response.warning.fields)
    entry.resolve()
  })
  created.on('error', (error: unknown) => abandon(created, error))
  created.on('exit', (code) => {
    if (worker === created) abandon(created, new Error(`Backup worker exited with code ${code}.`))
  })
  created.unref()
  worker = created
  return created
}

function enqueue(absolutePath: string, bytes: Buffer, completion?: SharedArrayBuffer): void {
  if (disabled) return
  let current: Worker
  try { current = ensureWorker() } catch (error) {
    disabled = true
    log.warn('backup store: worker could not start; recording disabled', { error: describeError(error) })
    return
  }
  const id = nextId++
  let resolve!: () => void
  const settled = new Promise<void>((done) => { resolve = done })
  const timer = setTimeout(() => abandon(current, new Error(`Backup record did not finish within ${BACKUP_RECORD_TIMEOUT_MS} ms.`)), BACKUP_RECORD_TIMEOUT_MS)
  pending.set(id, { worker: current, settled, resolve, timer })
  try { current.postMessage({ id, absolutePath, bytes, completion } satisfies BackupRequest) }
  catch (error) { abandon(current, error) }
}

export function record(absolutePath: string, bytes: Buffer): void {
  if (accepting) enqueue(absolutePath, bytes)
}

/** Fatal-path best effort: wait only for the off-thread attempt's completion.
 * On timeout its physical outcome is unknown; no history promise delays exit. */
export function recordBeforeExit(absolutePath: string, bytes: Buffer): void {
  // A fatal caller may arrive after ordinary shutdown drained the store.
  if (!worker && closing) closing = null
  const completion = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  enqueue(absolutePath, bytes, completion)
  if (!disabled && Atomics.wait(new Int32Array(completion), 0, 0, TERMINAL_RECORD_TIMEOUT_MS) === 'timed-out') {
    console.warn('tapebox: terminal backup outcome is unknown; its wait expired')
  }
}

export function flushBackupStore(): Promise<void> {
  return Promise.all([...pending.values()].map((entry) => entry.settled)).then(() => {})
}

export function closeBackupStore(): Promise<void> {
  if (closing) return closing
  accepting = false
  closing = (async () => {
    let timeout: NodeJS.Timeout | undefined
    await Promise.race([flushBackupStore(), new Promise<void>((resolve) => { timeout = setTimeout(resolve, CLOSE_DRAIN_TIMEOUT_MS) })])
    clearTimeout(timeout)
    const current = worker
    worker = null
    if (current) {
      if ([...pending.values()].some((entry) => entry.worker === current)) {
        log.warn('backup store: quit drain expired; unfinished record outcomes are unknown', {})
      }
      for (const [id, entry] of pending) {
        if (entry.worker !== current) continue
        pending.delete(id)
        clearTimeout(entry.timer)
        entry.resolve()
      }
      void retire(current)
    }
    await Promise.all([...retirements.values()])
  })()
  return closing
}
