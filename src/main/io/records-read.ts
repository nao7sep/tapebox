import { Worker } from 'node:worker_threads'
import { paths } from '@main/paths'
import type { RecordsRead, RecordsReadResults } from './records-query'
import type { RecordsWorkerData, RecordsWorkerRequest, RecordsWorkerResponse } from './records-worker'

/**
 * The main process's side of the Records window's reads: each one goes to the
 * reader thread (records-worker.ts), so the database work stays off the main
 * thread. A local read gets no timeout. A reader that fails or exits fails its
 * waiting reads, and the next read starts a new one. Startup opens the writer's
 * schema before the Records window can read.
 */

type Pending = { resolve: (value: never) => void; reject: (error: Error) => void }

let worker: Worker | null = null
let closed = false
let nextId = 1
const pending = new Map<number, Pending>()

function failAll(error: Error): void {
  for (const [id, entry] of pending) {
    pending.delete(id)
    entry.reject(error)
  }
}

function discard(current: Worker, error: Error): void {
  if (worker !== current) return
  worker = null
  failAll(error)
  void current.terminate().catch(() => undefined)
}

function ensureWorker(): Worker {
  if (closed) throw new Error('The records reader was closed.')
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
    if (!entry) return
    pending.delete(response.id)
    if (response.ok) entry.resolve(response.value as never)
    else entry.reject(new Error(response.error))
  })
  created.on('error', (error: unknown) => discard(created, error instanceof Error ? error : new Error(String(error))))
  created.on('exit', (code) => discard(created, new Error(`The records reader exited with code ${code}.`)))
  worker = created
  return created
}

export function readRecords<R extends RecordsRead>(read: R): Promise<RecordsReadResults[R['op']]> {
  return new Promise((resolve, reject) => {
    const current = ensureWorker()
    const id = nextId++
    pending.set(id, { resolve: resolve as (value: never) => void, reject })
    try { current.postMessage({ id, read } satisfies RecordsWorkerRequest) }
    catch (error) { discard(current, error instanceof Error ? error : new Error(String(error))) }
  })
}

/** Stop the reader thread at quit; any read still waiting fails. The quit's
 * exit deadline bounds the wait. */
export async function closeRecordsReader(): Promise<void> {
  closed = true
  const current = worker
  worker = null
  failAll(new Error('The records reader was closed.'))
  if (current) await current.terminate().catch(() => undefined)
}
