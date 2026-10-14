import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

// How an owned process tree is stopped on each platform, with the platform
// supplied and the child processes faked, so every branch runs on any host.
// Windows stops a tree with `taskkill /T /F`, bounded, with a direct kill as the
// fallback, and cancellation settles only after taskkill has; a forced exit kills
// the direct children there and the process groups on POSIX. spawn.test.ts runs
// the real trees on the host's own platform.

type FakeChild = EventEmitter & {
  pid: number
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: Record<string, unknown>; child: unknown }>)

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  let nextPid = 4000
  return {
    spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      const child = Object.assign(new EventEmitter(), {
        pid: nextPid++,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      })
      spawned.push({ command, args, options, child })
      return child
    }),
  }
})

const { killOwnedProcessesNow, spawnStreaming, TREE_STOP_BOUND_MS, waitForExit } = await import('@main/io/spawn')

function onPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
}

function spawnedChild(index: number): FakeChild {
  return spawned[index]!.child as FakeChild
}

/** Start a tool run and cancel it; returns the tool, the run's settlement and the controller. */
function startAndCancel() {
  const controller = new AbortController()
  const tool = spawnStreaming('yt-dlp', ['https://example.test/v'], { signal: controller.signal }) as unknown as FakeChild
  const settled = waitForExit(tool as never).then(() => 'resolved', (error: Error) => error.name)
  controller.abort()
  return { tool, settled }
}

afterEach(() => {
  // Release every fake from the owned set.
  for (const { child } of spawned) (child as FakeChild).emit('close', null, 'SIGKILL')
  spawned.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('stopping an owned tree on Windows', () => {
  it('runs taskkill on the whole tree and settles the cancel only after taskkill has', async () => {
    onPlatform('win32')
    const { tool, settled } = startAndCancel()
    expect(spawned[0]!.options).toMatchObject({ detached: false })
    expect(spawned[1]).toMatchObject({ command: 'taskkill', args: ['/PID', String(tool.pid), '/T', '/F'], options: { windowsHide: true } })

    tool.emit('close', 1, null)
    await new Promise((resolve) => setTimeout(resolve, 10))
    let done = false
    void settled.then(() => { done = true })
    await Promise.resolve()
    expect(done, 'the tree may still be alive until taskkill settles').toBe(false)

    spawnedChild(1).emit('close', 0, null)
    await expect(settled).resolves.toBe('AbortError')
    expect(tool.kill).not.toHaveBeenCalled()
  })

  it('kills the tool directly when taskkill fails', async () => {
    onPlatform('win32')
    const { tool, settled } = startAndCancel()
    spawnedChild(1).emit('close', 128, null)
    tool.emit('close', 1, null)
    await expect(settled).resolves.toBe('AbortError')
    expect(tool.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('kills the tool directly when taskkill cannot start', async () => {
    onPlatform('win32')
    const { tool, settled } = startAndCancel()
    spawnedChild(1).emit('error', Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' }))
    tool.emit('close', 1, null)
    await expect(settled).resolves.toBe('AbortError')
    expect(tool.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('stops a hung taskkill within the Windows tree bound and falls back to a direct kill', async () => {
    vi.useFakeTimers()
    onPlatform('win32')
    const { tool, settled } = startAndCancel()
    tool.emit('close', 1, null)

    await vi.advanceTimersByTimeAsync(TREE_STOP_BOUND_MS.windows - 1)
    expect(spawnedChild(1).kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnedChild(1).kill).toHaveBeenCalled()
    expect(tool.kill).toHaveBeenCalledWith('SIGTERM')
    await expect(settled).resolves.toBe('AbortError')
  })
})

describe('a forced exit per platform', () => {
  it('Windows kills each owned direct child, with no process-group signal', () => {
    onPlatform('win32')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const tool = spawnStreaming('yt-dlp', []) as unknown as FakeChild
    killOwnedProcessesNow()
    expect(tool.kill).toHaveBeenCalledWith('SIGKILL')
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'] as const)('%s kills each owned process group and its leader', (platform) => {
    onPlatform(platform)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const tool = spawnStreaming('yt-dlp', []) as unknown as FakeChild
    expect(spawned[0]!.options).toMatchObject({ detached: true })
    killOwnedProcessesNow()
    expect(kill).toHaveBeenCalledWith(-tool.pid, 'SIGKILL')
    expect(tool.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
