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
      stdout: stdoutText,
      stderr: 'ERROR: nope',
    })
    expect(JSON.parse(row.args)).toEqual(args)
  })
})
