import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { collectRunFacts, killOwnedProcessesNow, spawnStreaming, waitForExit } from '@main/io/spawn'
import { StopRequest } from '@main/stop-request'

function readReadyPid(child: ReturnType<typeof spawnStreaming>, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = ''
    function cleanup() {
      child.stdout.off('data', onData)
      child.off('close', onClose)
      child.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    function onData(chunk: Buffer): void {
      output += chunk.toString()
      const match = /ready:(\d+)/.exec(output)
      if (!match) return
      cleanup()
      resolve(Number(match[1]))
    }
    function onError(error: Error) { cleanup(); reject(error) }
    function onClose() { onError(new Error('fixture closed before reporting readiness')) }
    function onAbort() { cleanup(); reject(signal!.reason) }
    child.stdout.on('data', onData)
    child.once('close', onClose)
    child.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

describe('owned subprocess cancellation', () => {
  it.runIf(process.platform !== 'win32')(
    'escalates from SIGTERM and terminates the owned POSIX process group',
    async ({ signal, task }) => {
      const descendant =
        `process.on('SIGTERM', () => {}); ` +
        `process.send('ready'); setInterval(() => {}, 1000)`
      const parent =
        // The parent obeys SIGTERM; readiness comes from the descendant after its
        // handler is installed, so cancellation must escalate to stop the group.
        `process.once('SIGTERM', () => process.exit(0)); ` +
        `const descendant = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); ` +
        `descendant.once('message', () => process.stdout.write('ready:' + descendant.pid + '\\n')); ` +
        `setInterval(() => {}, 1000)`
      const controller = new AbortController()
      const child = spawnStreaming(process.execPath, ['-e', parent], { signal: controller.signal })
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      const exited = waitForExit(child, { command: 'POSIX tree fixture' })
      // Observe rejection immediately, including a failed fixture startup.
      void exited.catch(() => {})
      let descendantPid: number | undefined

      try {
        descendantPid = await readReadyPid(child, signal)
        controller.abort()
        await expect(exited).rejects.toHaveProperty('name', 'AbortError')
        // The owned group must be gone at settlement: a surviving descendant
        // would keep it alive. The OS may retain the dead descendant's PID briefly
        // after removing its group membership, so reaping is observed separately.
        expect(() => process.kill(-child.pid!, 0)).toThrow()
        await vi.waitFor(() => expect(() => process.kill(descendantPid!, 0)).toThrow(), { timeout: task.timeout })
      } finally {
        // Clean up even when readiness or the escalation assertion fails. Use the
        // fixture's recorded group, independently of the termination under test.
        try { process.kill(-child.pid!, 'SIGKILL') } catch { /* the group is gone */ }
        child.kill('SIGKILL')
        await closed
        if (descendantPid !== undefined) {
          await vi.waitFor(() => expect(() => process.kill(descendantPid!, 0)).toThrow(), { timeout: task.timeout })
        }
      }
    },
    15_000,
  )

  it.runIf(process.platform === 'win32')(
    'terminates descendants before the parent reports cancellation',
    async () => {
      const descendant = `setInterval(() => {}, 1000)`
      const parent =
        `const descendant = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); ` +
        `process.stdout.write('ready:' + descendant.pid + '\\n'); setInterval(() => {}, 1000)`
      const controller = new AbortController()
      const child = spawnStreaming(process.execPath, ['-e', parent], { signal: controller.signal })
      const exited = waitForExit(child, { command: 'tree fixture' })

      const descendantPid = await readReadyPid(child)
      controller.abort()
      await expect(exited).rejects.toHaveProperty('name', 'AbortError')
      // Cancellation settlement is the disk-safety boundary used by queue.cancel:
      // the descendant must already be gone, not merely scheduled for taskkill.
      expect(() => process.kill(descendantPid, 0)).toThrow()
    },
    30_000,
  )
})

describe('a forced exit', () => {
  /** Whether `pid` is gone, waiting for the OS to reap it. */
  async function goneSoon(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { process.kill(pid, 0) } catch { return true }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }

  it.runIf(process.platform !== 'win32')('kills every owned POSIX process group at once, without a grace', async () => {
    const descendant = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
    const parent =
      `process.on('SIGTERM', () => {}); ` +
      `const descendant = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); ` +
      `process.stdout.write('ready:' + descendant.pid + '\\n'); setInterval(() => {}, 1000)`
    const child = spawnStreaming(process.execPath, ['-e', parent])
    const exited = waitForExit(child, { reject: false })
    const descendantPid = await readReadyPid(child)

    killOwnedProcessesNow()

    await exited
    expect(await goneSoon(descendantPid), 'the descendant died with its group').toBe(true)
    expect(() => process.kill(-child.pid!, 0)).toThrow()
  })

  it.runIf(process.platform === 'win32')('kills the owned direct children', async () => {
    const child = spawnStreaming(process.execPath, ['-e', `process.stdout.write('ready:' + process.pid + '\\n'); setInterval(() => {}, 1000)`])
    const exited = waitForExit(child, { reject: false })
    const pid = await readReadyPid(child)

    killOwnedProcessesNow()

    await exited
    expect(await goneSoon(pid)).toBe(true)
  })
})

describe('why a collected run ended early', () => {
  const waiting = ['-e', 'setInterval(() => {}, 1000)']

  async function stopOf(args: string[], opts: Parameters<typeof spawnStreaming>[2], abort?: (child: ReturnType<typeof spawnStreaming>) => void) {
    const child = spawnStreaming(process.execPath, args, opts)
    const output = collectRunFacts(child)
    abort?.(child)
    await waitForExit(child, { reject: false }).catch(() => {})
    return output.stop()
  }

  it('is none for a run that ended by itself', async () => {
    expect(await stopOf(['-e', 'process.exit(3)'], {})).toBeNull()
  })

  it.each(['cancel', 'quit'] as const)('is %s when TapeBox stopped it for that reason', async (by) => {
    const controller = new AbortController()
    expect(await stopOf(waiting, { signal: controller.signal }, () => controller.abort(new StopRequest(by)))).toBe(by)
  })

  it('is none for an abort that gave no reason TapeBox knows', async () => {
    const controller = new AbortController()
    expect(await stopOf(waiting, { signal: controller.signal }, () => controller.abort())).toBeNull()
  })

  it('is idle when the idle watchdog ended it', async () => {
    expect(await stopOf(waiting, { idleTimeoutMs: 50 })).toBe('idle')
  })
})


it('captures monotonic elapsed time at close despite wall-clock jumps and later recording', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-23T10:00:00Z'))
  let monotonic = 100
  const now = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  try {
    const output = collectRunFacts(child)
    expect(output.elapsedMs()).toBeNull()
    vi.setSystemTime(new Date('2026-10-23T09:00:00Z'))
    monotonic = 350
    child.emit('close', 0, null)
    expect(output.elapsedMs()).toBe(250)
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
    monotonic = 10_000
    expect(output.elapsedMs()).toBe(250)
  } finally {
    now.mockRestore()
    vi.useRealTimers()
    child.stdout.destroy()
    child.stderr.destroy()
  }
})
