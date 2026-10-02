import { describe, expect, it, vi } from 'vitest'
import { SubprocessError } from '@main/io/spawn'

// Node stands in for yt-dlp: the site args become `-e <script> --`, so every
// flag the service appends after them reaches the script as a plain argument.
const { writeRecord, script } = vi.hoisted(() => ({ writeRecord: vi.fn(), script: { text: '' } }))
vi.mock('@main/io/records', () => ({ writeRecord }))
vi.mock('@main/paths', () => ({ binaryPath: () => process.execPath, paths: { bin: '/bin' } }))
vi.mock('@main/services/ytdlp-args', () => ({ resolveYtdlpArgs: () => ['-e', script.text, '--'] }))

const { probe } = await import('@main/services/ytdlp')

describe('probe', () => {
  it('records the run with its tape and whole output', async () => {
    writeRecord.mockClear()
    const json = JSON.stringify({ _type: 'video', id: 'abc', title: 'Clip' })
    script.text = `process.stdout.write(${JSON.stringify(json)})`

    const result = await probe('t1', 'https://example.com/v', new AbortController().signal)

    expect(result).toMatchObject({ kind: 'video', id: 'abc', title: 'Clip' })
    expect(writeRecord).toHaveBeenCalledOnce()
    const [table, row] = writeRecord.mock.calls[0]!
    expect(table).toBe('ytdlp_runs')
    expect(row).toMatchObject({ tape_id: 't1', scan_id: null, kind: 'probe', url: 'https://example.com/v', exit_code: 0, stdout: json })
  })

  it('records a failed run and throws with yt-dlp stderr', async () => {
    writeRecord.mockClear()
    script.text = `process.stderr.write('ERROR: Unsupported URL'); process.exit(1)`

    const failure = probe('t1', 'https://example.com/v', new AbortController().signal)

    await expect(failure).rejects.toBeInstanceOf(SubprocessError)
    await expect(failure).rejects.toMatchObject({ exitCode: 1, stderr: 'ERROR: Unsupported URL' })
    expect(writeRecord).toHaveBeenCalledOnce()
    expect(writeRecord.mock.calls[0]![1]).toMatchObject({ kind: 'probe', exit_code: 1, stderr: 'ERROR: Unsupported URL' })
  })
})
