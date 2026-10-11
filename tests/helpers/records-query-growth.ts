import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { readPage } from '../../src/main/io/records-query.ts'
import type { RecordWriteResponse } from '../../src/main/io/records-write-worker.ts'
import type { RecordsQuery } from '../../src/shared/records.ts'

/** Bootstrap the actual writer's schema without touching an app data home. */
export async function createRecordsDatabase(path: string): Promise<void> {
  const worker = new Worker(new URL('../../src/main/io/records-write-worker.ts', import.meta.url), {
    workerData: { databasePath: path, logsPath: join(path, '..', 'logs'), fallbackPath: join(path, '..', 'fallback.log'), session: 'synthetic-query-session' },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject)
      worker.once('message', (response: RecordWriteResponse) => {
        if (response.diagnostics.length) reject(new Error(response.diagnostics.join('\n')))
        else resolve()
      })
      worker.postMessage({ id: 1 })
    })
  } finally {
    await worker.terminate()
  }
}

export const chronologicalIndexes = `
  CREATE INDEX IF NOT EXISTS idx_logs_time_id ON logs (time DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_calls_time_id ON ai_calls (started_at_utc DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ytdlp_runs_time_id ON ytdlp_runs (started_at_utc DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ffmpeg_runs_time_id ON ffmpeg_runs (started_at_utc DESC, id DESC);
`

export const recordsQuery = (overrides: Partial<RecordsQuery> = {}): RecordsQuery => ({
  session: null, kind: null, level: null, tapeId: null, search: '', after: null, ...overrides,
})

/** Capture the SQL the real page reader executes, for SQLite's own planner. */
function pageStatement(db: DatabaseSync, query = recordsQuery()): { sql: string; values: SQLInputValue[] } {
  let sql = ''
  let values: SQLInputValue[] = []
  const originalPrepare = db.prepare
  const prepare = originalPrepare.bind(db)
  db.prepare = (source: string) => {
    sql = source
    const statement = prepare(source)
    const all = statement.all.bind(statement)
    // readPage supplies positional values; the cast retains Node's unused
    // named-parameter overload on the observed statement.
    statement.all = ((...params: SQLInputValue[]) => { values = params; return all(...params) }) as typeof statement.all
    return statement
  }
  try { readPage(db, query) } finally { db.prepare = originalPrepare }
  return { sql, values }
}

export function pageQueryPlan(db: DatabaseSync, query = recordsQuery()): string[] {
  const { sql, values } = pageStatement(db, query)
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>
  return rows.map((row) => row.detail)
}

/** Append only synthetic fixtures, with repeated times across all four kinds. */
export function growRecords(db: DatabaseSync, from: number, to: number): void {
  const log = db.prepare('INSERT INTO logs (session, time, level, message, tape_id, fields) VALUES (?, ?, ?, ?, ?, ?)')
  const ai = db.prepare('INSERT INTO ai_calls (session, tape_id, started_at_utc, ended_at_utc, endpoint, model, request, status, response, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const ytdlp = db.prepare('INSERT INTO ytdlp_runs (session, tape_id, scan_id, kind, url, args, started_at_utc, ended_at_utc, exit_code, signal, stop_reason, stdout, stderr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const ffmpeg = db.prepare('INSERT INTO ffmpeg_runs (session, tape_id, kind, args, started_at_utc, ended_at_utc, exit_code, signal, stop_reason, stdout, stderr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  db.exec('BEGIN')
  try {
    for (let index = from; index < to; index++) {
      const time = new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 20) * 1000).toISOString()
      const session = `synthetic-session-${Math.floor(index / 4000)}`
      const tape = `synthetic-tape-${index % 1000}`
      // Logs are most frequent; each timestamp also contains calls and runs.
      if (index % 20 < 11) log.run(session, time, 'info', `synthetic log ${index}`, tape, '{}')
      else if (index % 20 < 14) ai.run(session, tape, time, time, 'https://example.invalid/api', 'synthetic-model', '{}', 200, '{}', null)
      else if (index % 20 < 18) ytdlp.run(session, tape, null, 'download', 'https://example.invalid/media', '[]', time, time, 0, null, null, 'synthetic output', '')
      else ffmpeg.run(session, tape, 'thumbnail', '[]', time, time, 0, null, null, '', '')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function medianQueryTime(run: () => unknown): number {
  for (let index = 0; index < 3; index++) run()
  const samples: number[] = []
  for (let index = 0; index < 21; index++) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  return Number(samples.sort((left, right) => left - right)[Math.floor(samples.length / 2)]!.toFixed(3))
}

/** Manual measurement: node tests/helpers/records-query-growth.ts. No timing gate. */
export async function measureRecordsQueryGrowth() {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-records-query-growth-'))
  let db: DatabaseSync | null = null
  try {
    const path = join(root, 'records.sqlite3')
    await createRecordsDatabase(path)
    db = new DatabaseSync(path)
    // Reproduce the prior schema even when the current writer creates indexes.
    const drop = ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs'].map((table) => `DROP INDEX IF EXISTS idx_${table}_time_id`).join(';')
    let from = 0
    const samples = []
    for (const size of [4000, 40_000, 400_000]) {
      db.exec(drop)
      growRecords(db, from, size)
      from = size
      const { sql: finalSql, values } = pageStatement(db)
      // Reproduce the prior outer-SELECT shape around the exact current
      // newest-page selections, rather than keeping a second field inventory.
      const order = finalSql.lastIndexOf(' ORDER BY')
      const baselineSql = `SELECT * FROM (${finalSql.slice(0, order)})${finalSql.slice(order)}`
      const run = (sql: string) => db!.prepare(sql).all(...values)
      const plan = (sql: string) => (db!.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as Array<{ detail: string }>).map((row) => row.detail)
      const baselinePlan = plan(baselineSql)
      const baselineMs = medianQueryTime(() => run(baselineSql))
      const baselinePage = run(baselineSql)
      db.exec(chronologicalIndexes)
      const indexesOnlyPlan = plan(baselineSql)
      const indexesOnlyMs = medianQueryTime(() => run(baselineSql))
      const finalPlan = plan(finalSql)
      const finalMs = medianQueryTime(() => run(finalSql))
      const finalPage = run(finalSql)
      samples.push({ rows: size, baselineMs, indexesOnlyMs, finalMs, samePage: JSON.stringify(baselinePage) === JSON.stringify(finalPage), baselinePlan, indexesOnlyPlan, finalPlan })
    }
    return { node: process.version, sqlite: db.prepare('SELECT sqlite_version() AS version').get()!.version, samples }
  } finally {
    db?.close()
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.log(JSON.stringify(await measureRecordsQueryGrowth(), null, 2))
}
