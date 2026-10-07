import { Worker } from 'node:worker_threads'
import { paths } from '@main/paths'
import type { RecordsRead, RecordsReadResults } from './records-query'
import type { RecordsWorkerData, RecordsWorkerRequest, RecordsWorkerResponse } from './records-worker'
import { log } from './logger'
import { describeError } from '@shared/error'

/**
 * The main process's side of the Records window's reads: each one goes to the
 * reader thread (records-worker.ts), so the database work stays off the main
 * thread (PLAYBOOK, Own the work in flight). A read that has not answered within
 * READ_TIMEOUT_MS fails, and the thread it is stuck on is abandoned; the next
 * read starts a fresh one (PLAYBOOK, Bound every external wait).
 */

export const READ_TIMEOUT_MS = 10_000

type Pending = { worker: Worker; resolve: (value: never) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const retirements = new Map<Worker, Promise<void>>()
let closing: Promise<void> | null = null

function failOwned(current: Worker, error: Error): void {
  for (const [id, entry] of pending) {
    if (entry.worker !== current) continue
    pending.delete(id)
    const { reject, timer } = entry
    clearTimeout(timer)
    reject(error)
  }
}

function retire(current: Worker): Promise<void> {
  const existing = retirements.get(current)
  if (existing) return existing
  const retirement = current.terminate().then(() => {
    retirements.delete(current)
  }, (error: unknown) => {
    retirements.delete(current)
    log.warn('records reader did not retire cleanly', { error: describeError(error) })
  })
  retirements.set(current, retirement)
  return retirement
}

function abandon(current: Worker, error: Error): void {
  if (worker === current) worker = null
  void retire(current)
  failOwned(current, error)
}

function ensureWorker(): Worker {
  if (closing) throw new Error('The records reader was closed.')
  if (worker) return worker
  // Tests run the source through Node's type stripping; the app runs
  // electron-vite's records-worker.js entry beside index.js.
  const module = import.meta.url.endsWith('.ts') ? './records-worker.ts' : './records-worker.js'
  const created = new Worker(new URL(module, import.meta.url), {
    workerData: { databasePath: paths.records } satisfies RecordsWorkerData,
  })
  created.unref()
  created.on('message', (response: RecordsWorkerResponse) => {
    const entry = pending.get(response.id)
    if (!entry || entry.worker !== created) return
    pending.delete(response.id)
    clearTimeout(entry.timer)
    if (response.ok) entry.resolve(response.value as never)
    else entry.reject(new Error(response.error))
  })
  created.on('error', (error: unknown) => {
    abandon(created, error instanceof Error ? error : new Error(String(error)))
  })
  created.on('exit', (code) => {
    if (worker === created) abandon(created, new Error(`The records reader exited with code ${code}.`))
  })
  worker = created
  return created
}

export function readRecords<R extends RecordsRead>(read: R): Promise<RecordsReadResults[R['op']]> {
  return new Promise((resolve, reject) => {
    const current = ensureWorker()
    const id = nextId++
    const timer = setTimeout(() => {
      abandon(current, new Error(`The records read did not answer within ${READ_TIMEOUT_MS} ms.`))
    }, READ_TIMEOUT_MS)
    pending.set(id, { worker: current, resolve: resolve as (value: never) => void, reject, timer })
    try {
      current.postMessage({ id, read } satisfies RecordsWorkerRequest)
    } catch (error) {
      abandon(current, error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Stop the reader thread at quit; any read still waiting fails. */
export function closeRecordsReader(): Promise<void> {
  if (closing) return closing
  const current = worker
  worker = null
  if (current) {
    failOwned(current, new Error('The records reader was closed.'))
    void retire(current)
  }
  closing = Promise.all([...retirements.values()]).then(() => undefined)
  return closing
}
