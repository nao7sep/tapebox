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
  it('waits for a read without a deadline', async () => {
    const read = reader.readRecords({ op: 'sources' })
    const worker = state.workers[0]!
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    worker.emit('message', { id: worker.requests[0]!.id, ok: true, value: { sessions: ['late'], tapeIds: [] } })
    await expect(read).resolves.toEqual({ sessions: ['late'], tapeIds: [] })
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('fails the reads of a reader that errs, and an old reader cannot reject its replacement\'s read', async () => {
    const first = reader.readRecords({ op: 'sources' })
    const old = state.workers[0]!
    const rejected = expect(first).rejects.toThrow('old failure')
    old.emit('error', new Error('old failure'))
    await rejected
    expect(old.terminate).toHaveBeenCalledOnce()

    const second = reader.readRecords({ op: 'sources' })
    const current = state.workers[1]!
    old.emit('error', new Error('late old worker error'))
    old.emit('exit', 1)
    current.emit('message', { id: current.requests[0]!.id, ok: true, value: { sessions: ['current'], tapeIds: [] } })
    await expect(second).resolves.toEqual({ sessions: ['current'], tapeIds: [] })
  })

  it('close rejects its waiting reads, seals new admission and waits for the thread to stop', async () => {
    const pending = reader.readRecords({ op: 'sources' })
    const rejected = expect(pending).rejects.toThrow('was closed')
    const worker = state.workers[0]!
    const closing = reader.closeRecordsReader()
    await rejected
    await expect(reader.readRecords({ op: 'sources' })).rejects.toThrow('was closed')
    expect(state.workers).toHaveLength(1)
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    worker.release()
    await closing
    expect(closed).toBe(true)
  })

  it('a postMessage failure rejects every read on that reader', async () => {
    const first = reader.readRecords({ op: 'sources' })
    const worker = state.workers[0]!
    worker.postMessage = () => { throw new Error('postMessage unavailable') }
    const failed = reader.readRecords({ op: 'sources' })
    await expect(first).rejects.toThrow('postMessage unavailable')
    await expect(failed).rejects.toThrow('postMessage unavailable')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
