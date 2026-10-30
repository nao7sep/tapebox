import { describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

const jobs = vi.hoisted(() => ({
  started: [] as string[],
  stopped: [] as string[],
  settled: [] as string[],
}))

vi.mock('@main/queue/job', () => ({
  Job: class {
    readonly tapeId: string
    private finish: () => void = () => {}
    private readonly done: Promise<void>
    constructor(tape: Tape) {
      this.tapeId = tape.id
      this.done = new Promise<void>((resolve) => { this.finish = resolve })
    }
    run(): Promise<void> {
      jobs.started.push(this.tapeId)
      return this.done
    }
    stop(): Promise<void> {
      jobs.stopped.push(this.tapeId)
      // The process tree exits later; stop resolves only after it has.
      setImmediate(() => {
        jobs.settled.push(this.tapeId)
        this.finish()
      })
      return this.done
    }
    cancel(): Promise<void> { return this.stop() }
  },
}))

const tapes = vi.hoisted(() => [] as Tape[])
vi.mock('@main/store/session', () => ({
  getTapes: () => tapes,
  upsertTape: vi.fn((tape: Tape) => { const index = tapes.findIndex((value) => value.id === tape.id); if (index >= 0) tapes[index] = tape }),
}))
vi.mock('@main/store/config', () => ({
  getSettings: () => ({ maxConcurrentDownloads: 2, autoStartDownloads: true }),
  getCollectionDir: () => '/library',
}))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

function queued(id: string): Tape {
  // Added together, so the Inbox (and the queue) takes them by id.
  return {
    id, state: 'queued', sourceUrl: `https://example.com/${id}`,
    addedAtUtc: '2026-01-01T00:00:00.000Z', addedIndex: 0, shelved: false,
  } as Tape
}

describe('queue and library moves', () => {
  it('starts no job while the library moves and catches up on the next tick', async () => {
    vi.resetModules()
    const queue = await import('@main/queue/manager')
    const { withCollectionMove } = await import('@main/collection-writes')
    tapes.push(queued('h1'))
    let startedWhileHeld: string[] = []
    await withCollectionMove(async () => {
      queue.tick()
      startedWhileHeld = [...jobs.started]
    })
    queue.tick()
    expect(startedWhileHeld).toEqual([])
    expect(jobs.started).toEqual(['h1'])
    await queue.shutdown()
    tapes.length = 0
    jobs.started.length = 0
    jobs.stopped.length = 0
    jobs.settled.length = 0
  })
})

describe('tapes held out of scheduling', () => {
  it('starts no job for a held tape, and catches up when the hold is released', async () => {
    vi.resetModules()
    const queue = await import('@main/queue/manager')
    tapes.push(queued('held'), queued('free'))
    const release = queue.holdFromScheduling(['held'])
    queue.tick()
    expect(jobs.started).toEqual(['free'])
    release()
    expect(jobs.started).toEqual(['free', 'held'])
    release()
    expect(jobs.started, 'a release ticks once').toEqual(['free', 'held'])
    await queue.shutdown()
    tapes.length = 0
    jobs.started.length = 0
    jobs.stopped.length = 0
    jobs.settled.length = 0
  })
})

describe('queue shutdown', () => {
  it.each([false, true])('resumes stopped attempts only after their jobs settle (drained=%s)', async (drained) => {
    vi.resetModules()
    jobs.started.length = 0
    jobs.stopped.length = 0
    jobs.settled.length = 0
    tapes.length = 0
    const queue = await import('@main/queue/manager')
    tapes.push(queued('resume'))
    queue.tick()
    tapes[0] = { ...tapes[0]!, state: 'downloading' }
    const closing = queue.shutdown()
    if (drained) await closing
    queue.resumeAfterQuit()
    if (!drained) expect(jobs.started).toEqual(['resume'])
    await closing
    await Promise.resolve()
    expect(jobs.started).toEqual(['resume', 'resume'])
    expect(tapes[0]!.state).toBe('queued')
    await queue.shutdown()
    tapes.length = 0
    jobs.started.length = 0
    jobs.stopped.length = 0
    jobs.settled.length = 0
  })

  it('stops every running job, waits for each to settle, and starts no more', async () => {
    vi.resetModules()
    const queue = await import('@main/queue/manager')
    tapes.push(queued('a'), queued('b'), queued('c'))
    queue.tick()
    expect(jobs.started).toEqual(['a', 'b'])

    await queue.shutdown()

    expect(jobs.stopped.sort()).toEqual(['a', 'b'])
    expect(jobs.settled.sort()).toEqual(['a', 'b'])
    // The finished jobs' finally → tick() must not start the third tape.
    await new Promise((resolve) => setImmediate(resolve))
    queue.tick()
    expect(jobs.started).toEqual(['a', 'b'])
    tapes.length = 0
    jobs.started.length = 0
    jobs.stopped.length = 0
    jobs.settled.length = 0
  })
})


describe('queue diagnostic credentials', () => {
  it('masks signed source URLs in the job-start log without changing the job input', async () => {
    vi.resetModules()
    const queue = await import('@main/queue/manager')
    const { log } = await import('@main/io/logger')
    const tape = queued('signed')
    tape.sourceUrl = 'https://user:password@example.com/video?id=42&sig=secret&pot=proof'
    tapes.push(tape)
    try {
      queue.tick()
      expect(log.info).toHaveBeenCalledWith('job start', {
        tapeId: 'signed', url: 'https://[REDACTED]@example.com/video?id=42&sig=[REDACTED]&pot=[REDACTED]',
      })
      expect(tape.sourceUrl).toContain('sig=secret&pot=proof')
    } finally {
      await queue.shutdown()
      tapes.length = 0
      jobs.started.length = 0
      jobs.stopped.length = 0
      jobs.settled.length = 0
    }
  })
})


describe('queued user cancellation', () => {
  it('pauses synchronously before another scheduler tick can start it', async () => {
    vi.resetModules()
    const queue = await import('@main/queue/manager')
    const { emit } = await import('@main/ipc/events')
    const tape = { ...queued('cancel-waiting'), failureCode: 'download', lastError: 'old failure' } as Tape
    tapes.push(tape)
    try {
      const cancelling = queue.cancel(tape.id)
      expect(tapes[0]).toMatchObject({ state: 'paused', failureCode: null, lastError: null })
      expect(emit).toHaveBeenCalledWith('tapes:updated', tapes[0])
      queue.tick()
      expect(jobs.started).toEqual([])
      await cancelling
    } finally {
      await queue.shutdown()
      tapes.length = 0
      jobs.started.length = 0
      jobs.stopped.length = 0
      jobs.settled.length = 0
    }
  })
})
