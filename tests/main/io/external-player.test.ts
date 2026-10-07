import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const subprocess = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => subprocess)
const { openExternalPlayer } = await import('@main/io/external-player')

let child: EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
  subprocess.spawn.mockReturnValue(child)
})
afterEach(() => vi.useRealTimers())

describe('external-player handoff', () => {
  it('waits for a direct executable to start, then lets it outlive TapeBox without waiting for exit', async () => {
    const opening = openExternalPlayer('C:\\Program Files\\VLC\\vlc.exe', 'C:\\media\\Take.mp4', 'win32')
    expect(child.unref).not.toHaveBeenCalled()
    expect(subprocess.spawn).toHaveBeenCalledExactlyOnceWith('C:\\Program Files\\VLC\\vlc.exe', ['C:\\media\\Take.mp4'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.emit('spawn')
    await opening
    expect(child.unref).toHaveBeenCalledOnce()
    await vi.runAllTimersAsync()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('rejects a failed direct launch with the original diagnostic error', async () => {
    const opening = openExternalPlayer('missing-player', '/media/Take.mp4', 'linux')
    const error = Object.assign(new Error('spawn missing-player ENOENT'), { code: 'ENOENT' })
    const rejected = expect(opening).rejects.toBe(error)
    child.emit('error', error)
    await rejected
    expect(child.unref).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a direct launch that never reports success or failure', async () => {
    const opening = openExternalPlayer('stuck-player', '/media/Take.mp4', 'win32')
    const rejected = expect(opening).rejects.toThrow('The operation was aborted')
    await vi.runAllTimersAsync()
    await rejected
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('owns late child errors after timeout until close and preserves the timeout if killing also fails', async () => {
    child.kill.mockImplementation(() => {
      child.emit('error', new Error('asynchronous kill failure'))
      throw new Error('synchronous kill failure')
    })
    const opening = openExternalPlayer('stuck-player', '/media/Take.mp4', 'win32')
    const rejected = expect(opening).rejects.toThrow('The operation was aborted')
    await vi.runAllTimersAsync()
    await rejected
    expect(() => child.emit('error', new Error('late launch failure'))).not.toThrow()
    child.emit('close')
    expect(child.listenerCount('error')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for the macOS handoff helper to finish successfully', async () => {
    subprocess.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, '', ''))
      return child
    })
    await openExternalPlayer('IINA', '/media/Take.mp4', 'darwin')
    expect(subprocess.execFile).toHaveBeenCalledExactlyOnceWith('/usr/bin/open', ['-a', 'IINA', '/media/Take.mp4'], {
      timeout: 5_000, killSignal: 'SIGKILL',
    }, expect.any(Function))
    expect(subprocess.spawn).not.toHaveBeenCalled()
  })

  it.each([['unavailable app', 1], ['timed-out helper', 'SIGKILL']])('rejects a macOS %s', async (_case, code) => {
    const error = Object.assign(new Error('open failed'), { code })
    subprocess.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(error, '', 'diagnostic stderr'))
      return child
    })
    await expect(openExternalPlayer('missing-app', '/media/Take.mp4', 'darwin')).rejects.toBe(error)
  })
})
