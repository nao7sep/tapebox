import { describe, expect, it } from 'vitest'
import { collectOutput, spawnStreaming, waitForExit } from '@main/io/spawn'
import { StopRequest } from '@main/stop-request'

function readReadyPid(child: ReturnType<typeof spawnStreaming>): Promise<number> {
  return new Promise((resolve) => {
    let output = ''
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /ready:(\d+)/.exec(output)
      if (!match) return
      child.stdout.off('data', onData)
      resolve(Number(match[1]))
    }
    child.stdout.on('data', onData)
  })
}

describe('owned subprocess cancellation', () => {
  it.runIf(process.platform !== 'win32')(
    'escalates from SIGTERM and terminates the owned POSIX process group',
    async () => {
      const descendant =
        `process.on('SIGTERM', () => {}); ` +
        `setInterval(() => {}, 1000)`
      const parent =
        // Mutation target: the direct parent exits on SIGTERM while its descendant
        // ignores it. Resolving on parent close would leave the descendant alive.
        `process.once('SIGTERM', () => process.exit(0)); ` +
        `const descendant = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); ` +
        `process.stdout.write('ready:' + descendant.pid + '\\n'); setInterval(() => {}, 1000)`
      const controller = new AbortController()
      const child = spawnStreaming(process.execPath, ['-e', parent], { signal: controller.signal })
      const exited = waitForExit(child, { command: 'POSIX tree fixture' })

      const descendantPid = await readReadyPid(child)
      controller.abort()
      await expect(exited).rejects.toHaveProperty('name', 'AbortError')
      expect(() => process.kill(descendantPid, 0)).toThrow()
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

describe('why a collected run ended early', () => {
  const waiting = ['-e', 'setInterval(() => {}, 1000)']

  async function stopOf(args: string[], opts: Parameters<typeof spawnStreaming>[2], abort?: (child: ReturnType<typeof spawnStreaming>) => void) {
    const child = spawnStreaming(process.execPath, args, opts)
    const output = collectOutput(child)
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
