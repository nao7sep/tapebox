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
  constructor(_url: URL, options: { workerData: { responsePort: FakePort } }) {
    super(); this.responsePort = options.workerData.responsePort; state.workers.push(this)
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

it('reports a failed writer and sends unfinished and later records to the console', async () => {
  records.openRecords()
  records.writeRecord('logs', { time: 'now', level: 'info', message: 'record', tape_id: null, fields: '{}' }, () => 'record fallback')
  const worker = state.workers[0]!
  const flushed = records.flushRecords()
  worker.emit('error', new Error('writer failed'))
  await flushed
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unfinished write outcomes are unknown'))
  expect(console.log).toHaveBeenCalledWith('record fallback')
  expect(records.writeRecord('logs', { message: 'after the failure' }, () => 'after the failure')).toBe(true)
  expect(console.log).toHaveBeenCalledWith('after the failure')
  worker.emit('error', new Error('stale error'))
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(state.workers).toHaveLength(1)
  await records.closeRecords()
  expect(vi.getTimerCount()).toBe(0)
})

it('drains the queued records at close without a deadline before stopping the writer', async () => {
  records.openRecords()
  records.writeRecord('logs', { message: 'held' }, () => 'held')
  const worker = state.workers[0]!
  const closing = records.closeRecords()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(worker.terminate).not.toHaveBeenCalled()
  for (const request of worker.requests) worker.emit('message', { id: request.id, stored: false, diagnostics: [] })
  worker.release()
  await closing
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(console.error).not.toHaveBeenCalled()
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
  records.flushRecordsBeforeExit(500)
  expect(wait).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 500)
  expect(worker.requests.at(-1)!.completion).toBeInstanceOf(SharedArrayBuffer)
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unfinished write outcomes are unknown'))
  expect(console.log).toHaveBeenCalledWith('fatal fallback')
  const requestCount = worker.requests.length
  records.flushRecordsBeforeExit(500)
  expect(worker.requests).toHaveLength(requestCount)
  expect(records.writeRecord('logs', { message: 'late' }, () => 'late')).toBe(true)
})

it('shares chunk admission without publishing an incomplete run', async () => {
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
})
