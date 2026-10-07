import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RecordWriteRequest } from '@main/io/records-write-worker'

const state = vi.hoisted(() => ({ workers: [] as FakeWorker[] }))
class FakeWorker extends EventEmitter {
  requests: RecordWriteRequest[] = []
  release!: () => void
  retirement = new Promise<number>((resolve) => { this.release = () => resolve(0) })
  terminate = vi.fn(() => this.retirement)
  constructor() { super(); state.workers.push(this) }
  unref(): void {}
  postMessage(request: RecordWriteRequest): void { this.requests.push(request) }
}
vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }))
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
  records.writeRecord('logs', { time: 'now', level: 'info', message: 'record', tape_id: null, fields: '{}' }, () => 'record fallback')
  const worker = state.workers[0]!
  const flushed = records.flushRecords()
  await vi.advanceTimersByTimeAsync(records.RECORD_WRITE_TIMEOUT_MS)
  await flushed
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unfinished write outcomes are unknown'))
  expect(console.log).toHaveBeenCalledWith('record fallback')
  const closing = records.closeRecords()
  let closed = false
  void closing.then(() => { closed = true })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(closed).toBe(false)
  worker.emit('error', new Error('stale error'))
  worker.emit('message', { id: worker.requests[1]!.id, stored: true, diagnostics: [] })
  expect(worker.terminate).toHaveBeenCalledOnce()
  worker.release()
  await closing
  expect(vi.getTimerCount()).toBe(0)
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
