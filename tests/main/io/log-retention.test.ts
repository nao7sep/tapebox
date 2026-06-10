import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneOldLogs, selectPrunableLogFiles } from '@main/io/log-retention'

const FILES = [
  '20260610-010000-utc.log',
  '20260610-020000-utc.log',
  '20260610-030000-utc.log',
  'notes.txt',
]

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('selectPrunableLogFiles', () => {
  it('selects only logs older than the retained newest set', () => {
    expect(selectPrunableLogFiles(FILES, 2)).toEqual(['20260610-010000-utc.log'])
  })

  it('returns every log when retaining zero, and ignores non-log files', () => {
    expect(selectPrunableLogFiles(FILES, 0)).toEqual([
      '20260610-030000-utc.log',
      '20260610-020000-utc.log',
      '20260610-010000-utc.log',
    ])
  })

  it('treats a negative retain count as no pruning', () => {
    expect(selectPrunableLogFiles(FILES, -1)).toEqual([])
  })
})

describe('pruneOldLogs', () => {
  it('deletes old log files and leaves retained logs plus unrelated files', async () => {
    const dir = await createLogDir(FILES)

    await pruneOldLogs(2, dir)

    await expectFiles(dir, [
      '20260610-020000-utc.log',
      '20260610-030000-utc.log',
      'notes.txt',
    ])
  })

  it('can prune every log file without touching non-log files', async () => {
    const dir = await createLogDir(FILES)

    await pruneOldLogs(0, dir)

    await expectFiles(dir, ['notes.txt'])
  })

  it('does nothing when the log directory is missing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tapebox-logs-parent-'))
    tempDirs.push(parent)

    await expect(pruneOldLogs(2, join(parent, 'missing'))).resolves.toBeUndefined()
  })
})

async function createLogDir(files: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tapebox-logs-'))
  tempDirs.push(dir)
  await Promise.all(files.map((file) => writeFile(join(dir, file), 'x')))
  return dir
}

async function expectFiles(dir: string, expected: string[]): Promise<void> {
  expect((await readdir(dir)).sort()).toEqual([...expected].sort())
}
