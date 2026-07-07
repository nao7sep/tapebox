import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// logger.ts resolves its session path from TAPEBOX_HOME (paths.ts), so the
// override must be set BEFORE the module is imported — the same path-relocation
// seam api-keys.test.ts uses (storage-path-conventions).
const root = mkdtempSync(join(tmpdir(), 'tapebox-logger-'))
const prevHome = process.env.TAPEBOX_HOME
process.env.TAPEBOX_HOME = root

const { initLogger, closeLogger, getCurrentLogPath, log } = await import('@main/io/logger')
const { paths } = await import('@main/paths')

mkdirSync(paths.logs, { recursive: true })

afterEach(() => {
  closeLogger()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.TAPEBOX_HOME
  else process.env.TAPEBOX_HOME = prevHome
  rmSync(root, { recursive: true, force: true })
})

describe('initLogger', () => {
  it('opens a fresh session file exclusively and writes to it', () => {
    const path = initLogger({ debug: false })
    expect(getCurrentLogPath()).toBe(path)
    expect(existsSync(path)).toBe(true)

    log.info('session opened')
    const onDisk = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(onDisk).toMatchObject({ level: 'info', message: 'session opened' })
  })

  it('degrades a same-millisecond clash to the console instead of interleaving two sessions', () => {
    // Freeze time so two initLogger() calls compute the identical
    // yyyymmdd-hhmmss-fff-utc filename — the vanishing clash the exclusive-create
    // open exists to handle.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const firstPath = initLogger({ debug: false })
    expect(getCurrentLogPath()).toBe(firstPath)
    log.info('first session line')

    // Second "process" computes the same filename. Exclusive-create must fail
    // (EEXIST) rather than reopen in append mode and interleave into the first
    // session's file.
    const secondPath = initLogger({ debug: false })
    expect(secondPath).toBe(firstPath)
    expect(getCurrentLogPath()).toBeNull()

    const openFailedLine = vi
      .mocked(console.error)
      .mock.calls.map(([line]) => String(line))
      .find((line) => line.includes('log file open failed'))
    expect(openFailedLine).toBeDefined()
    expect(JSON.parse(openFailedLine!)).toMatchObject({
      level: 'error',
      message: 'log file open failed; using console',
    })

    // Degraded logging goes to the console, never appended behind the first
    // session's back.
    log.warn('would-be second session line')
    const onDisk = readFileSync(firstPath, 'utf8')
    expect(onDisk).toContain('first session line')
    expect(onDisk).not.toContain('would-be second session line')
  })
})
