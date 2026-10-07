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

it('bounds a held record, ignores its stale reply, and joins the actual retirement once', async () => {
  backup.record('/file', Buffer.from('bytes'))
  const worker = state.workers[0]!
  let flushed = false
  const flush = backup.flushBackupStore().then(() => { flushed = true })
  await vi.advanceTimersByTimeAsync(backup.BACKUP_RECORD_TIMEOUT_MS)
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

it('seals ordinary admission immediately and gives a held quit drain a finite wait', async () => {
  backup.record('/file', Buffer.from('bytes'))
  const worker = state.workers[0]!
  const closing = backup.closeBackupStore()
  expect(backup.closeBackupStore()).toBe(closing)
  backup.record('/ignored', Buffer.from('ignored'))
  expect(worker.messages).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(state.warn).toHaveBeenCalledWith('backup store: quit drain expired; unfinished record outcomes are unknown', {})
  worker.release()
  await closing
  expect(vi.getTimerCount()).toBe(0)
})
