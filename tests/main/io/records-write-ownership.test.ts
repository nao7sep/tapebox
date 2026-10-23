import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RecordWriteRequest } from '@main/io/records-write-worker'

const state = vi.hoisted(() => ({ workers: [] as FakeWorker[] }))
class FakePort extends EventEmitter {
  queue: unknown[] = []
  peer!: FakePort
  postMessage(value: unknown): void { this.peer.queue.push(value); this.peer.emit('message', value) }
  close(): void {}
  unref(): void {}
}
class FakeChannel {
  port1 = new FakePort()
  port2 = new FakePort()
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1 }
}
class FakeWorker extends EventEmitter {
  requests: RecordWriteRequest[] = []
  release!: () => void
  retirement = new Promise<number>((resolve) => { this.release = () => resolve(0) })
  terminate = vi.fn(() => this.retirement)
  responsePort: FakePort
  textOnly: boolean
  constructor(_url: URL, options: { workerData: { responsePort: FakePort; textOnly?: boolean } }) {
    super(); this.responsePort = options.workerData.responsePort; this.textOnly = options.workerData.textOnly ?? false; state.workers.push(this)
  }
  override emit(event: string, ...args: unknown[]): boolean {
    if (event === 'message') { this.responsePort.postMessage(args[0]); return true }
    return super.emit(event, ...args)
  }
  unref(): void {}
  postMessage(request: RecordWriteRequest): void { this.requests.push(request) }
}
vi.mock('node:worker_threads', () => ({ Worker: FakeWorker, MessageChannel: FakeChannel, receiveMessageOnPort: (port: FakePort) => port.queue.length ? { message: port.queue.shift() } : undefined }))
vi.mock('@main/paths', () => ({ paths: { records: '/unused/records.sqlite3', logs: '/unused/logs' } }))
let records: typeof import('@main/io/records')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  state.workers.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  records = await import('@main/io/records')
})
afterEach(async () => {
  for (const worker of state.workers) worker.release()
  const closing = records.closeRecords()
  await vi.runAllTimersAsync()
  await closing
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('bounds a held writer, retains unknown outcome diagnostics and joins its actual retirement', async () => {
  records.openRecords()
  const initialization = records.waitForRecordsInitialization()
  records.writeRecord('logs', { time: 'now', level: 'info', message: 'record', tape_id: null, fields: '{}' }, () => 'record fallback')
  const worker = state.workers[0]!
  const flushed = records.flushRecords()
  await vi.advanceTimersByTimeAsync(records.RECORD_WRITE_TIMEOUT_MS)
  await flushed
  await initialization
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unfinished write outcomes are unknown'))
  expect(console.log).toHaveBeenCalledWith('record fallback')
  // Later records still reach the launch's text file through one replacement writer.
  expect(state.workers.map((created) => created.textOnly)).toEqual([false, true])
  const replacement = state.workers[1]!
  expect(records.waitForRecordsInitialization()).toBe(initialization)
  records.writeRecord('logs', { message: 'after the stall' }, () => 'after the stall')
  expect(replacement.requests.map((request) => request.text ?? null)).toEqual([null, 'after the stall'])
  for (const request of replacement.requests) replacement.emit('message', { id: request.id, stored: false, diagnostics: [] })
  const closing = records.closeRecords()
  let closed = false
  void closing.then(() => { closed = true })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(closed).toBe(false)
  worker.emit('error', new Error('stale error'))
  worker.emit('message', { id: worker.requests[1]!.id, stored: true, diagnostics: [] })
  expect(worker.terminate).toHaveBeenCalledOnce()
  worker.release()
  replacement.release()
  await closing
  expect(vi.getTimerCount()).toBe(0)
})

it('sends a record to the console rather than queue it without bound behind a slow writer', () => {
  records.openRecords()
  const worker = state.workers[0]!
  for (let index = 0; index < records.RECORD_PENDING_LIMIT - 1; index++) records.writeRecord('logs', { message: 'queued' }, () => 'queued')
  expect(records.writeRecord('logs', { message: 'over' }, () => 'over the limit')).toBe(true)
  expect(console.log).toHaveBeenCalledWith('over the limit')
  expect(worker.requests).toHaveLength(records.RECORD_PENDING_LIMIT)
})

it('captures only the first initialization settlement per open and ignores a previous launch acknowledgement', async () => {
  await records.waitForRecordsInitialization() // Before open, the reader owns any missing-file failure.
  records.openRecords()
  const old = state.workers[0]!
  const firstInitialization = records.waitForRecordsInitialization()
  old.emit('message', { id: old.requests[0]!.id, stored: false, diagnostics: [] })
  await firstInitialization
  const closed = records.closeRecords()
  old.release()
  await closed

  records.openRecords()
  const current = state.workers[1]!
  const nextInitialization = records.waitForRecordsInitialization()
  expect(nextInitialization).not.toBe(firstInitialization)
  let initialized = false
  void nextInitialization.then(() => { initialized = true })
  old.emit('message', { id: old.requests[0]!.id, stored: false, diagnostics: [] })
  await Promise.resolve()
  expect(initialized).toBe(false)

  records.writeRecord('logs', { message: 'later pending write' }, () => 'later pending write')
  current.emit('message', { id: current.requests[0]!.id, stored: false, diagnostics: [] })
  await nextInitialization
  expect(initialized).toBe(true)
  expect(records.waitForRecordsInitialization()).toBe(nextInitialization)
  expect(vi.getTimerCount()).toBe(1) // The later write is still admitted and held.
  current.emit('message', { id: current.requests[1]!.id, stored: true, diagnostics: [] })
  await records.flushRecords()
})

it('seals writes at close while draining stored acknowledgements exactly once', async () => {
  const stored = vi.fn()
  records.onRecordStored(stored)
  records.openRecords()
  records.writeRecord('logs', { message: 'owned' }, () => 'owned')
  const worker = state.workers[0]!
  const closing = records.closeRecords()
  expect(records.closeRecords()).toBe(closing)
  expect(records.writeRecord('logs', { message: 'late' }, () => 'late')).toBe(true)
  expect(worker.requests).toHaveLength(2)
  for (const request of worker.requests) worker.emit('message', { id: request.id, stored: !!request.table, diagnostics: [] })
  await Promise.resolve()
  await Promise.resolve()
  worker.release()
  await closing
  expect(stored).toHaveBeenCalledOnce()
  expect(console.log).toHaveBeenCalledWith('late')
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds the terminal barrier, seals writes and preserves the unknown outcome if it expires', async () => {
  records.openRecords()
  records.writeRecord('logs', { message: 'fatal' }, () => 'fatal fallback')
  const worker = state.workers[0]!
  const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
  records.flushRecordsBeforeExit()
  expect(wait).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, records.TERMINAL_RECORD_DRAIN_MS)
  expect(worker.requests.at(-1)!.completion).toBeInstanceOf(SharedArrayBuffer)
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unfinished write outcomes are unknown'))
  expect(console.log).toHaveBeenCalledWith('fatal fallback')
  const requestCount = worker.requests.length
  records.flushRecordsBeforeExit()
  expect(worker.requests).toHaveLength(requestCount)
  expect(records.writeRecord('logs', { message: 'late' }, () => 'late')).toBe(true)
})

it('shares chunk admission and fallback without publishing an incomplete run', async () => {
  const stored = vi.fn()
  records.onRecordStored(stored)
  records.openRecords()
  const worker = state.workers[0]!
  records.writeOutputChunk('run-key', 'stderr', 3, 'evidence')
  const request = worker.requests.at(-1)!
  expect(request.chunk).toEqual({ runKey: 'run-key', stream: 'stderr', sequence: 3, content: 'evidence' })
  expect(JSON.parse(request.text!)).toMatchObject({ session: records.currentSession(), runKey: 'run-key', stream: 'stderr', sequence: 3, content: 'evidence' })
  for (const queued of worker.requests) worker.emit('message', { id: queued.id, stored: false, diagnostics: [] })
  await records.flushRecords()
  expect(stored).not.toHaveBeenCalled()
  for (let index = 0; index < records.RECORD_PENDING_LIMIT; index++) records.writeOutputChunk('run-key', 'stdout', index, 'chunk')
  records.writeOutputChunk('run-key', 'stdout', records.RECORD_PENDING_LIMIT, 'overflow')
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"content":"overflow"'))
})
