import { beforeEach, describe, expect, it, vi } from 'vitest'

type Registry = typeof import('@main/work-registry')
let registry: Registry

beforeEach(async () => {
  vi.resetModules()
  registry = await import('@main/work-registry')
})

function abortable(signal: AbortSignal, onSettle: () => void): Promise<string> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      setTimeout(() => {
        onSettle()
        reject(new Error('aborted'))
      }, 5)
    }, { once: true })
  })
}

describe('work registry', () => {
  it('cancels one keyed run without touching the others', async () => {
    let settled = 0
    const a = registry.runCancellable((signal) => abortable(signal, () => settled++), 'a')
    let bAborted = false
    const b = registry.runCancellable(async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      bAborted = signal.aborted
      return 'b'
    }, 'b')
    registry.cancelWork('a')
    await expect(a).rejects.toThrow('aborted')
    await expect(b).resolves.toBe('b')
    expect(settled).toBe(1)
    expect(bAborted).toBe(false)
  })

  it('aborts every run at quit, waits for each to settle, and refuses new work', async () => {
    const settled: string[] = []
    const runs = ['x', 'y'].map((name) =>
      registry.runCancellable((signal) => abortable(signal, () => settled.push(name))).catch(() => 'stopped'),
    )
    await registry.cancelAllWork()
    expect(settled.sort()).toEqual(['x', 'y'])
    await expect(Promise.all(runs)).resolves.toEqual(['stopped', 'stopped'])
    await expect(registry.runCancellable(async () => 'late')).rejects.toBeInstanceOf(registry.WorkClosedError)
  })
})
