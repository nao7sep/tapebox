import { describe, expect, it, vi } from 'vitest'

const { writeRecord } = vi.hoisted(() => ({ writeRecord: vi.fn() }))
vi.mock('@main/io/records', () => ({ writeRecord }))
vi.mock('@main/paths', () => ({ binaryPath: () => '/bin/yt-dlp', paths: { bin: '/bin' } }))

const { collectRun } = await import('@main/services/ytdlp')
const { spawnStreaming, waitForExit } = await import('@main/io/spawn')

describe('collectRun', () => {
  it('records both streams whole with the exit code once the run ends', async () => {
    const stdoutText = Array.from({ length: 200 }, (_, i) => `line ${i} ✓`).join('\n')
    const script = `process.stdout.write(${JSON.stringify(stdoutText)}); process.stderr.write('ERROR: nope'); process.exit(3)`
    const args = ['-e', script]
    const child = spawnStreaming(process.execPath, args)
    const run = collectRun(child, { kind: 'scan', tapeId: null, scanId: 's1', url: 'https://example.com/p', args })
    await waitForExit(child, { reject: false })
    expect(run.stderr()).toBe('ERROR: nope')
    run.record()

    expect(writeRecord).toHaveBeenCalledOnce()
    const [table, row] = writeRecord.mock.calls[0]!
    expect(table).toBe('ytdlp_runs')
    expect(row).toMatchObject({
      tape_id: null,
      scan_id: 's1',
      kind: 'scan',
      url: 'https://example.com/p',
      exit_code: 3,
      signal: null,
      stop_reason: null,
      stdout: stdoutText,
      stderr: 'ERROR: nope',
    })
    expect(JSON.parse(row.args)).toEqual(args)
  })

  it('masks credentials from the arguments wherever the run echoes them, and drops progress echoes', async () => {
    writeRecord.mockClear()
    const script = `process.stdout.write('tapebox-progress:50.0%|1|2\\n[download] got it\\n'); process.stderr.write('ERROR: login hunter22 rejected'); process.exit(1)`
    const args = ['-e', script, '--password', 'hunter22', '--add-header', 'Cookie: sid=abc123']
    const child = spawnStreaming(process.execPath, ['-e', script])
    const run = collectRun(child, { kind: 'download', tapeId: 't1', scanId: null, url: 'https://me:pw@example.com/v', args })
    await waitForExit(child, { reject: false })
    expect(run.stderr(), 'what an error or a log line would carry').toBe('ERROR: login [REDACTED] rejected')
    expect(run.mask('echo sid=abc123')).toBe('echo [REDACTED]')
    run.record()

    const [, row] = writeRecord.mock.calls[0]!
    expect(row.url).toBe('https://[REDACTED]@example.com/v')
    expect(JSON.parse(row.args).slice(2)).toEqual(['--password', '[REDACTED]', '--add-header', 'Cookie: [REDACTED]'])
    expect(row.stderr).toBe('ERROR: login [REDACTED] rejected')
    expect(row.stdout).toBe('[download] got it\n')
    expect(JSON.stringify(row)).not.toMatch(/hunter22|abc123|me:pw/)
  })
})
