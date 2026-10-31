import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ workers: [] as Array<FakeWorker>, warn: vi.fn() }))
class FakeWorker extends EventEmitter {
  messages: unknown[] = []
  release!: () => void
  termination = new Promise<number>((resolve) => { this.release = () => resolve(0) })
  terminate = vi.fn(() => this.termination)
  constructor() { super(); state.workers.push(this) }
  unref(): void {}
  postMessage(message: unknown): void { this.messages.push(message) }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }))
vi.mock('@main/paths', () => ({ paths: { backupsDb: '/unused/backups.sqlite3' } }))
vi.mock('@main/io/logger', () => ({ log: { warn: state.warn } }))
let backup: typeof import('@main/store/backupStore')

beforeEach(async () => {
  vi.resetModules()
  state.workers.length = 0
  state.warn.mockClear()
  vi.useFakeTimers()
  backup = await import('@main/store/backupStore')
})
afterEach(async () => {
  for (const worker of state.workers) worker.release()
  const closing = backup.closeBackupStore()
  await vi.runAllTimersAsync()
  await closing
  vi.useRealTimers()
})

it('settles a failed worker\'s record, ignores its stale reply, and joins the actual retirement once', async () => {
  backup.record('/file', Buffer.from('bytes'))
  const worker = state.workers[0]!
  let flushed = false
  const flush = backup.flushBackupStore().then(() => { flushed = true })
  worker.emit('error', new Error('worker failed'))
  await flush
  expect(flushed).toBe(true)
  expect(worker.terminate).toHaveBeenCalledOnce()
  const closing = backup.closeBackupStore()
  let closed = false
  void closing.then(() => { closed = true })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(closed).toBe(false)
  worker.emit('message', { id: 1 })
  worker.emit('error', new Error('late worker error'))
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(state.warn).toHaveBeenCalledOnce()
  backup.record('/ignored', Buffer.from('ignored'))
  expect(worker.messages).toHaveLength(1)
  worker.release()
  await closing
  expect(vi.getTimerCount()).toBe(0)
})

it('seals ordinary admission immediately and drains what was admitted before stopping the worker', async () => {
  backup.record('/file', Buffer.from('bytes'))
  const worker = state.workers[0]!
  const closing = backup.closeBackupStore()
  expect(backup.closeBackupStore()).toBe(closing)
  backup.record('/ignored', Buffer.from('ignored'))
  expect(worker.messages).toHaveLength(1)
  await Promise.resolve()
  expect(worker.terminate).not.toHaveBeenCalled()
  worker.emit('message', { id: 1 })
  worker.release()
  await closing
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('dispatches one snapshot at a time, in save order', async () => {
  backup.record('/first', Buffer.from('first'))
  const worker = state.workers[0]!
  backup.record('/shelf', Buffer.from('shelf-0'))
  backup.record('/shelf', Buffer.from('shelf-1'))
  backup.record('/settings', Buffer.from([0xff, 0x00, 0x0d, 0x0a]))
  expect(worker.messages).toHaveLength(1)
  let drained = false
  const flush = backup.flushBackupStore().then(() => { drained = true })
  worker.emit('message', { id: 1 })
  expect(worker.messages).toHaveLength(2)
  expect(worker.messages[1]).toMatchObject({ absolutePath: '/shelf', bytes: Buffer.from('shelf-0') })
  await Promise.resolve()
  expect(drained).toBe(false)
  worker.emit('message', { id: 2 })
  expect(worker.messages[2]).toMatchObject({ absolutePath: '/shelf', bytes: Buffer.from('shelf-1') })
  worker.emit('message', { id: 3 })
  expect(worker.messages[3]).toMatchObject({ absolutePath: '/settings', bytes: Buffer.from([0xff, 0x00, 0x0d, 0x0a]) })
  worker.emit('message', { id: 4 })
  await flush
  expect(drained).toBe(true)
  expect(state.warn).not.toHaveBeenCalled()
})

it('drains every waiting save at close without admitting a newer one', async () => {
  backup.record('/file', Buffer.from('initial'))
  backup.record('/file', Buffer.from('later'))
  const worker = state.workers[0]!
  const closing = backup.closeBackupStore()
  backup.record('/file', Buffer.from('after close'))
  worker.emit('message', { id: 1 })
  expect(worker.messages[1]).toMatchObject({ absolutePath: '/file', bytes: Buffer.from('later') })
  worker.emit('message', { id: 2 })
  worker.release()
  await closing
  expect(worker.messages).toHaveLength(2)
  expect(state.warn).not.toHaveBeenCalled()
})

it('skips the waiting backups at a session end and stops the worker', async () => {
  backup.record('/file', Buffer.from('initial'))
  backup.record('/file', Buffer.from('later'))
  const worker = state.workers[0]!
  const closing = backup.closeBackupStore({ drain: false })
  worker.emit('message', { id: 1 })
  worker.release()
  await closing
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(worker.messages).toHaveLength(1)
})
