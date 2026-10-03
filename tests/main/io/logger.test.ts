import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

const prevHome = process.env.TAPEBOX_DATA_DIR
const roots: string[] = []

/** A fresh storage root and fresh logger/records modules bound to it. */
async function freshApp() {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-records-'))
  roots.push(root)
  process.env.TAPEBOX_DATA_DIR = root
  vi.resetModules()
  const records = await import('@main/io/records')
  const { initLogger, log } = await import('@main/io/logger')
  const { paths } = await import('@main/paths')
  return { root, records, initLogger, log, paths }
}

function rows(file: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  if (prevHome === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = prevHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('log records', () => {
  it('writes each line as a row carrying its session and tape', async () => {
    const { records, initLogger, log, paths } = await freshApp()
    const session = records.openRecords()
    initLogger({ debug: false })

    log.info('job start', { tapeId: 't1', url: 'https://u:p@example.com/v' })
    log.warn('no tape here')
    log.debug('dropped in a release')
    records.closeRecords()

    expect(records.currentSession()).toBe(session)
    const logged = rows(paths.records, 'SELECT session, level, message, tape_id, fields FROM logs ORDER BY id')
    expect(logged).toEqual([
      {
        session,
        level: 'info',
        message: 'job start',
        tape_id: 't1',
        fields: JSON.stringify({ tapeId: 't1', url: 'https://u:p@example.com/v' }),
      },
      { session, level: 'warn', message: 'no tape here', tape_id: null, fields: '{}' },
    ])
  })

  it('writes to the console before the session opens and after it closes', async () => {
    const { records, log, paths } = await freshApp()
    const info = vi.spyOn(console, 'log').mockImplementation(() => {})

    log.info('too early')
    records.openRecords()
    records.closeRecords()
    log.info('too late')

    expect(info.mock.calls.map(([line]) => JSON.parse(String(line)).message)).toEqual(['too early', 'too late'])
    expect(rows(paths.records, 'SELECT * FROM logs')).toEqual([])
  })

  it('falls back to this session\'s text file under logs/ when the database cannot be opened', async () => {
    const { records, log, paths } = await freshApp()
    mkdirSync(paths.records) // a directory where the database should be
    records.openRecords()

    log.error('still recorded', { tapeId: 't2' })
    records.closeRecords()

    const [file] = readdirSync(paths.logs)
    expect(file).toMatch(/^\d{8}-\d{6}-\d{3}-utc\.log$/)
    const lines = readFileSync(join(paths.logs, file!), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toMatchObject([
      { level: 'error', message: 'records database could not be opened; writing to a text file' },
      { level: 'error', message: 'still recorded', tapeId: 't2' },
    ])
  })

  it('signals each row the database stored, so the Records window can show it', async () => {
    const { records, initLogger, log } = await freshApp()
    const stored = vi.fn()
    records.onRecordStored(stored)
    records.openRecords()
    initLogger({ debug: false })

    log.info('first')
    log.warn('second')
    expect(stored).toHaveBeenCalledTimes(2)
    records.closeRecords()
  })

  it('signals nothing for a row that went to the text file instead', async () => {
    const { records, log, paths } = await freshApp()
    mkdirSync(paths.records)
    const stored = vi.fn()
    records.onRecordStored(stored)
    records.openRecords()

    log.error('only in the text file')
    records.closeRecords()
    expect(stored).not.toHaveBeenCalled()
  })

  it('keeps recording when the stored listener throws', async () => {
    const { records, log, paths } = await freshApp()
    const errorLine = vi.spyOn(console, 'error').mockImplementation(() => {})
    records.onRecordStored(() => {
      throw new Error('window gone')
    })
    records.openRecords()

    log.info('still stored')
    records.closeRecords()
    expect(rows(paths.records, 'SELECT message FROM logs')).toEqual([{ message: 'still stored' }])
    expect(errorLine).toHaveBeenCalled()
  })
})
