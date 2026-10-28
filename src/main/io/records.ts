import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads'
import { join } from 'node:path'
import { paths } from '@main/paths'
import { describeError } from '@shared/error'
import type { LogLevel } from '@shared/log'
import { utcTimestampForFilename } from '@shared/utc'
import { toJson } from './log-format'
import type { RecordWriteData, RecordWriteRequest, RecordWriteResponse } from './records-write-worker'
export type { RecordTable, RecordRow } from './records-write-worker'
import type { RecordTable, RecordRow, ExecutionFacts } from './records-write-worker'

/** Records SQLite and fallback filesystem work belong to the writer thread.
 * Main owns admission, acknowledgements and commit notifications. Local storage
 * work has no deadline; only the exit sequence's one deadline bounds its drain. */
let session: string | null = null
let fallbackPath: string | null = null
let worker: Worker | null = null
let responsePort: MessagePort | null = null
let closed = false
let nextId = 1
let closing: Promise<void> | null = null
let terminalFlushed = false
let storedListener: (() => void) | null = null
type Pending = { settled: Promise<void>; resolve: () => void; text: string; level: LogLevel; mirrored: boolean }
const pending = new Map<number, Pending>()

function note(message: string, error: unknown): string {
  return toJson({ time: new Date().toISOString(), level: 'error', message, error: describeError(error) })
}

/** Stop the one writer of this launch; its port closes with it. */
function stopWriter(): Promise<void> {
  const current = worker
  const port = responsePort
  worker = null
  responsePort = null
  if (!current) return Promise.resolve()
  return current.terminate().then(() => {}, (error: unknown) => {
    toConsole('error', note('records writer did not stop cleanly', error))
  }).finally(() => port?.close())
}

/** The writer failed or exited: its unfinished records go to the console, and
 * so do later ones. */
function abandon(error: unknown): void {
  if (!worker) return
  toConsole('error', note('records writer failed; unfinished write outcomes are unknown', error))
  for (const [id, entry] of pending) {
    pending.delete(id)
    if (entry.text && !entry.mirrored) toConsole(entry.level, entry.text)
    entry.resolve()
  }
  void stopWriter()
}

function acknowledge(response: RecordWriteResponse): void {
  const entry = pending.get(response.id)
  if (!entry) return
  pending.delete(response.id)
  for (const diagnostic of response.diagnostics) toConsole('error', diagnostic)
  if (response.console && !entry.mirrored) toConsole(entry.level, response.console)
  if (response.stored) {
    try { storedListener?.() } catch (error) { toConsole('error', note('records stored listener failed', error)) }
  }
  entry.resolve()
}

/** Begin a launch synchronously; opening storage runs off thread, as the first
 * queued request. Startup drains it with {@link flushRecords} before the Records
 * window can read. */
export function openRecords(): string {
  if (worker) throw new Error('Records are already open.')
  const started = new Date()
  session = started.toISOString()
  // Seconds name it: one launch writes one file, and a launch takes longer than one.
  fallbackPath = join(paths.logs, `${utcTimestampForFilename(started)}.log`)
  closed = false
  closing = null
  terminalFlushed = false
  const { port1, port2 } = new MessageChannel()
  try {
    const module = import.meta.url.endsWith('.ts') ? './records-write-worker.ts' : './records-write-worker.js'
    const created = new Worker(new URL(module, import.meta.url), { workerData: {
      databasePath: paths.records, logsPath: paths.logs, responsePort: port2,
      fallbackPath, session,
    } satisfies RecordWriteData, transferList: [port2] })
    port1.on('message', acknowledge)
    port1.unref()
    created.on('error', abandon)
    created.on('exit', (code) => { if (worker === created) abandon(new Error(`Records writer exited with code ${code}.`)) })
    created.unref()
    worker = created
    responsePort = port1
    void enqueue({}, '', 'error', false)
  } catch (error) { port1.close(); port2.close(); toConsole('error', note('records writer could not start; using the console', error)) }
  return session
}

export function currentSession(): string | null { return session }
export function onRecordStored(listener: (() => void) | null): void { storedListener = listener }

function enqueue(request: Omit<RecordWriteRequest, 'id'>, text: string, level: LogLevel, mirrored: boolean): Promise<void> {
  if (!worker) return Promise.resolve()
  const id = nextId++
  let resolve!: () => void
  const settled = new Promise<void>((done) => { resolve = done })
  pending.set(id, { settled, resolve, text, level, mirrored })
  try { worker.postMessage({ ...request, id } satisfies RecordWriteRequest) }
  catch (error) { abandon(error) }
  return settled
}

/** Whether this call already printed its fallback to the console. */
export function writeRecord(table: RecordTable, row: RecordRow, text: () => string, level: LogLevel = 'info', mirrored = false, facts?: ExecutionFacts): boolean {
  if (session === null || closed || !worker) { toConsole(level, text()); return true }
  const line = text()
  enqueue({ table, row, text: line, facts }, line, level, mirrored)
  return false
}

/** Output chunks share the same writer and console fallback as metadata. */
export function writeOutputChunk(runKey: string, stream: 'stdout' | 'stderr', sequence: number, content: string): void {
  const text = toJson({ record: 'run output', session, runKey, stream, sequence, content })
  if (session === null || closed || !worker) { toConsole('info', text); return }
  enqueue({ chunk: { runKey, stream, sequence, content }, text }, text, 'info', false)
}

export function flushRecords(): Promise<void> {
  return Promise.all([...pending.values()].map((entry) => entry.settled)).then(() => {})
}

/** A terminal path cannot run another event-loop turn. Wait for the writer's
 * actual ordered barrier, at most what remains of the exit deadline, then
 * synchronously receive its full acknowledgements. */
export function flushRecordsBeforeExit(remainingMs: number): void {
  if (terminalFlushed) return
  terminalFlushed = true
  closed = true
  const port = responsePort
  if (!worker || !port) return
  const completion = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  enqueue({ completion }, '', 'error', false)
  const outcome = Atomics.wait(new Int32Array(completion), 0, 0, remainingMs)
  let response: ReturnType<typeof receiveMessageOnPort>
  while ((response = receiveMessageOnPort(port))) acknowledge(response.message as RecordWriteResponse)
  if (outcome === 'timed-out') abandon(new Error('Terminal Records drain expired; unfinished write outcomes are unknown.'))
}

/** Seal admission, drain what is queued, then stop the writer. The quit's exit
 * deadline bounds the wait; the writer is never abandoned mid-drain. */
export function closeRecords(): Promise<void> {
  if (closing) return closing
  closed = true
  closing = flushRecords().then(stopWriter)
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
