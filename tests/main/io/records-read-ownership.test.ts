import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordsWorkerRequest } from '@main/io/records-worker'

type ReaderWorker = EventEmitter & {
  requests: RecordsWorkerRequest[]
  release: () => void
  postMessage: (request: RecordsWorkerRequest) => void
  terminate: ReturnType<typeof vi.fn>
}
const state = vi.hoisted(() => ({ workers: [] as ReaderWorker[] }))

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      requests: RecordsWorkerRequest[] = []
      release!: () => void
      private retired = new Promise<number>((resolve) => { this.release = () => resolve(0) })
      terminate = vi.fn(() => this.retired)
      constructor() { super(); state.workers.push(this as ReaderWorker) }
      unref(): void {}
      postMessage(request: RecordsWorkerRequest): void { this.requests.push(request) }
    },
  }
})
vi.mock('@main/paths', () => ({ paths: { records: '/unused-records-reader-fixture.sqlite3' } }))
vi.mock('@main/io/logger', () => ({ log: { warn: vi.fn() } }))
vi.mock('@main/io/records', () => ({ flushRecords: async () => {} }))

let reader: typeof import('@main/io/records-read')

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  state.workers = []
  reader = await import('@main/io/records-read')
})

afterEach(async () => {
  const closing = reader.closeRecordsReader()
  for (const worker of state.workers) worker.release()
  await closing
  vi.useRealTimers()
})

describe('records reader ownership', () => {
  it('an old timed-out worker error cannot reject the replacement worker request', async () => {
    const first = reader.readRecords({ op: 'sources' })
    const rejected = expect(first).rejects.toThrow('did not answer')
    await vi.advanceTimersByTimeAsync(reader.READ_TIMEOUT_MS)
    await rejected
    const old = state.workers[0]!

    const second = reader.readRecords({ op: 'sources' })
    const current = state.workers[1]!
    await Promise.resolve()
    old.emit('error', new Error('late old worker error'))
    current.emit('message', { id: current.requests[0]!.id, ok: true, value: { sessions: ['current'], tapeIds: [] } })
    await expect(second).resolves.toEqual({ sessions: ['current'], tapeIds: [] })
    expect(old.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    const closing = reader.closeRecordsReader()
    let closed = false
    void closing.then(() => { closed = true })
    current.release()
    await Promise.resolve()
    expect(closed).toBe(false)
    old.release()
    await closing
    expect(closed).toBe(true)
  })

  it('close rejects its waiting reads, seals new admission and joins actual retirement', async () => {
    const pending = reader.readRecords({ op: 'sources' })
    const rejected = expect(pending).rejects.toThrow('was closed')
    const worker = state.workers[0]!
    const closing = reader.closeRecordsReader()
    expect(reader.closeRecordsReader()).toBe(closing)
    await rejected
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow('was closed')
    expect(state.workers).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    worker.release()
    await closing
    expect(closed).toBe(true)
  })

  it('a postMessage failure owns its timer, rejection and retirement', async () => {
    const first = reader.readRecords({ op: 'sources' })
    const old = state.workers[0]!
    const firstRejection = expect(first).rejects.toThrow('old failure')
    old.emit('error', new Error('old failure'))
    await firstRejection
    const next = reader.readRecords({ op: 'sources' })
    const worker = state.workers[1]!
    worker.postMessage = () => { throw new Error('postMessage unavailable') }
    const failed = reader.readRecords({ op: 'sources' })
    const nextRejection = expect(next).rejects.toThrow('postMessage unavailable')
    await expect(failed).rejects.toThrow('postMessage unavailable')
    await nextRejection
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
