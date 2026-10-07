import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { paths } from '@main/paths'
import { describeError } from '@shared/error'
import type { LogLevel } from '@shared/log'
import { utcTimestampForFilenameMs } from '@shared/utc'
import { toJson } from './log-format'
import type { RecordWriteData, RecordWriteRequest, RecordWriteResponse } from './records-write-worker'
export type { RecordTable, RecordRow } from './records-write-worker'
import type { RecordTable, RecordRow } from './records-write-worker'

/** Records SQLite and fallback filesystem work belong to the writer thread.
 * Main owns admission, acknowledgements, deadlines and commit notifications. */
export const RECORD_WRITE_TIMEOUT_MS = 10_000
const CLOSE_DRAIN_TIMEOUT_MS = 1_000
let session: string | null = null
let worker: Worker | null = null
let closed = false
let nextId = 1
let closing: Promise<void> | null = null
let storedListener: (() => void) | null = null
type Pending = { worker: Worker; settled: Promise<void>; resolve: () => void; timer: NodeJS.Timeout; text: string; level: LogLevel; mirrored: boolean }
const pending = new Map<number, Pending>()
const retirements = new Map<Worker, Promise<void>>()

function note(message: string, error: unknown): string {
  return toJson({ time: new Date().toISOString(), level: 'error', message, error: describeError(error) })
}

function retire(current: Worker): Promise<void> {
  const existing = retirements.get(current)
  if (existing) return existing
  const retirement = current.terminate().then(() => {}, (error: unknown) => {
    toConsole('error', note('records writer did not retire cleanly', error))
  }).finally(() => { retirements.delete(current) })
  retirements.set(current, retirement)
  return retirement
}

function abandon(current: Worker, error: unknown): void {
  if (worker !== current && ![...pending.values()].some((entry) => entry.worker === current)) return
  if (worker === current) worker = null
  toConsole('error', note('records writer failed; unfinished write outcomes are unknown', error))
  for (const [id, entry] of pending) {
    if (entry.worker !== current) continue
    pending.delete(id)
    clearTimeout(entry.timer)
    if (entry.text && !entry.mirrored) toConsole(entry.level, entry.text)
    entry.resolve()
  }
  void retire(current)
}

/** Begin a launch synchronously; opening storage runs off thread. */
export function openRecords(): string {
  if (worker) throw new Error('Records are already open.')
  const started = new Date()
  session = started.toISOString()
  closed = false
  closing = null
  try {
    const module = import.meta.url.endsWith('.ts') ? './records-write-worker.ts' : './records-write-worker.js'
    const created = new Worker(new URL(module, import.meta.url), { workerData: {
      databasePath: paths.records, logsPath: paths.logs,
      fallbackPath: join(paths.logs, `${utcTimestampForFilenameMs(started)}.log`), session,
    } satisfies RecordWriteData })
    created.on('message', (response: RecordWriteResponse) => {
      const entry = pending.get(response.id)
      if (!entry || entry.worker !== created) return
      pending.delete(response.id)
      clearTimeout(entry.timer)
      for (const diagnostic of response.diagnostics) toConsole('error', diagnostic)
      if (response.console && !entry.mirrored) toConsole(entry.level, response.console)
      if (response.stored) {
        try { storedListener?.() } catch (error) { toConsole('error', note('records stored listener failed', error)) }
      }
      entry.resolve()
    })
    created.on('error', (error: unknown) => abandon(created, error))
    created.on('exit', (code) => { if (worker === created) abandon(created, new Error(`Records writer exited with code ${code}.`)) })
    created.unref()
    worker = created
    enqueue({}, '', 'error', false)
  } catch (error) { toConsole('error', note('records writer could not start; using the console', error)) }
  return session
}

export function currentSession(): string | null { return session }
export function onRecordStored(listener: (() => void) | null): void { storedListener = listener }

function enqueue(request: Omit<RecordWriteRequest, 'id'>, text: string, level: LogLevel, mirrored: boolean): void {
  const current = worker
  if (!current) return
  const id = nextId++
  let resolve!: () => void
  const settled = new Promise<void>((done) => { resolve = done })
  const timer = setTimeout(() => abandon(current, new Error(`Records write did not finish within ${RECORD_WRITE_TIMEOUT_MS} ms.`)), RECORD_WRITE_TIMEOUT_MS)
  pending.set(id, { worker: current, settled, resolve, timer, text, level, mirrored })
  try { current.postMessage({ ...request, id } satisfies RecordWriteRequest) }
  catch (error) { abandon(current, error) }
}

/** Whether this call already printed its fallback to the console. */
export function writeRecord(table: RecordTable, row: RecordRow, text: () => string, level: LogLevel = 'info', mirrored = false): boolean {
  if (session === null || closed || !worker) { toConsole(level, text()); return true }
  const line = text()
  enqueue({ table, row, text: line }, line, level, mirrored)
  return false
}

export function flushRecords(): Promise<void> {
  return Promise.all([...pending.values()].map((entry) => entry.settled)).then(() => {})
}

/** Seal admission immediately, bound the drain, and join actual retirement. */
export function closeRecords(): Promise<void> {
  if (closing) return closing
  closed = true
  closing = (async () => {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([flushRecords(), new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_DRAIN_TIMEOUT_MS) })])
    clearTimeout(timer)
    const current = worker
    if (current) {
      if ([...pending.values()].some((entry) => entry.worker === current)) abandon(current, new Error('Records quit drain expired.'))
      else { worker = null; void retire(current) }
    }
    await Promise.all([...retirements.values()])
  })()
  return closing
}

export function toConsole(level: LogLevel, line: string): void {
  const text = line.endsWith('\n') ? line.slice(0, -1) : line
  try {
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  } catch {
    // If even the console is gone there is nothing left to try.
  }
}
