import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/io/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@main/paths', () => ({ binaryPath: () => '/bin/yt-dlp' }))

const { scanOutcome } = await import('@main/services/ytdlp-scan')

const ended = { aborted: false, failure: null, exitCode: 0, totalCount: 0, stderrTail: '' }

describe('scanOutcome', () => {
  it('reports a clean exit as done, even with nothing listed', () => {
    expect(scanOutcome({ ...ended, totalCount: 0 })).toEqual({ kind: 'done', totalCount: 0 })
  })

  it('treats a stopped scan as stopped, never as a failure', () => {
    expect(scanOutcome({ ...ended, aborted: true, failure: new Error('aborted'), exitCode: null, totalCount: 4 }))
      .toEqual({ kind: 'stopped', totalCount: 4 })
  })

  it('keeps the entries a scan listed before yt-dlp failed', () => {
    expect(scanOutcome({ ...ended, exitCode: 1, totalCount: 12 })).toEqual({ kind: 'done', totalCount: 12 })
    expect(scanOutcome({ ...ended, failure: new Error('idle'), exitCode: null, totalCount: 3 }))
      .toEqual({ kind: 'done', totalCount: 3 })
  })

  it('reports a failed exit with nothing listed as a failure carrying yt-dlp reason', () => {
    const outcome = scanOutcome({ ...ended, exitCode: 1, stderrTail: 'ERROR: Unsupported URL' })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { error: Error }).error.message).toContain('Unsupported URL')

    const idle = new Error('no output')
    expect(scanOutcome({ ...ended, failure: idle, exitCode: null })).toEqual({ kind: 'failed', error: idle })
  })
})
