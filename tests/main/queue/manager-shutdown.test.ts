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
      // The process tree takes a moment to exit; stop resolves only after it has.
      setTimeout(() => {
        jobs.settled.push(this.tapeId)
        this.finish()
      }, 5)
      return this.done
    }
    cancel(): Promise<void> { return this.stop() }
  },
}))

const tapes = vi.hoisted(() => [] as Tape[])
vi.mock('@main/store/session', () => ({
  getTapes: () => tapes,
  upsertTape: vi.fn(),
}))
vi.mock('@main/store/config', () => ({
  getSettings: () => ({ maxConcurrentDownloads: 2, autoStartDownloads: true }),
}))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

function queued(id: string): Tape {
  return { id, state: 'queued', sourceUrl: `https://example.com/${id}` } as Tape
}

describe('queue shutdown', () => {
  it('stops every running job, waits for each to settle, and starts no more', async () => {
    const queue = await import('@main/queue/manager')
    tapes.push(queued('a'), queued('b'), queued('c'))
    queue.tick()
    expect(jobs.started).toEqual(['a', 'b'])

    await queue.shutdown()

    expect(jobs.stopped.sort()).toEqual(['a', 'b'])
    expect(jobs.settled.sort()).toEqual(['a', 'b'])
    // The finished jobs' finally → tick() must not start the third tape.
    await new Promise((resolve) => setTimeout(resolve, 10))
    queue.tick()
    expect(jobs.started).toEqual(['a', 'b'])
  })
})
