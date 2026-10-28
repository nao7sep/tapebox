import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readPage, readSources, readDetail, readOutput } from '@main/io/records-query'
import type { RecordKind, RecordsQuery, RecordSummary } from '@shared/records'
import { createRecordsDatabase, growRecords, pageQueryPlan, recordsQuery } from '../../helpers/records-query-growth'

const roots: string[] = []
const databases: DatabaseSync[] = []

async function freshDatabase() {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-records-query-'))
  roots.push(root)
  const path = join(root, 'records.sqlite3')
  await createRecordsDatabase(path)
  const db = new DatabaseSync(path)
  databases.push(db)
  return { db, path }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Small, deliberately unbounded oracle: read facts, then select in memory. */
function referenceRecords(db: DatabaseSync) {
  const sources: Array<{ table: string; kind: RecordKind; search: string[] }> = [
    { table: 'logs', kind: 'log', search: ['message', 'tape_id', 'fields'] },
    { table: 'ai_calls', kind: 'ai-call', search: ['endpoint', 'model', 'tape_id', 'request', 'response', 'error'] },
    { table: 'ytdlp_runs', kind: 'ytdlp-run', search: ['kind', 'url', 'args', 'tape_id', 'scan_id'] },
    { table: 'ffmpeg_runs', kind: 'ffmpeg-run', search: ['kind', 'args', 'tape_id'] },
  ]
  return sources.flatMap((source) => {
    const rows = db.prepare(`SELECT * FROM ${source.table}`).all() as Array<Record<string, string | number | null>>
    return rows.map((row) => {
      const isLog = source.kind === 'log'
      const isCall = source.kind === 'ai-call'
      const level: RecordSummary['level'] = isLog ? row.level as RecordSummary['level']
        : isCall ? row.error === null ? 'info' : 'error'
        : row.stop_reason === 'cancel' || row.stop_reason === 'quit' ? 'warn'
        : row.exit_code === 0 ? 'info' : 'error'
      const record: RecordSummary = {
        kind: source.kind, id: Number(row.id), session: String(row.session), time: String(isLog ? row.time : row.started_at_utc), level,
        title: String(isLog ? row.message : isCall ? row.model : `${source.kind === 'ytdlp-run' ? 'yt-dlp' : 'ffmpeg'} ${row.kind}`),
        text: isCall ? String(row.endpoint) : source.kind === 'ytdlp-run' ? String(row.url) : null,
        tapeId: row.tape_id === null ? null : String(row.tape_id),
      }
      const searched = source.search.map((column) => row[column] === null ? '' : String(row[column]).toLowerCase())
      if (!isLog && !isCall) {
        const chunks = db.prepare(`SELECT content FROM run_output_chunks JOIN run_outputs ON run_outputs.run_key = run_output_chunks.run_key WHERE record_table = ? AND record_id = ? AND session = ?`).all(source.table, row.id!, row.session!) as { content: string }[]
        searched.push(...chunks.map(({ content }) => content.toLowerCase()))
      }
      return { record, searched }
    })
  })
}

function referencePage(facts: ReturnType<typeof referenceRecords>, query: RecordsQuery) {
  const search = query.search.trim().toLowerCase()
  const rows = facts.filter(({ record, searched }) => {
    if (query.kind !== null && record.kind !== query.kind) return false
    if (query.session !== null && record.session !== query.session) return false
    if (query.tapeId !== null && record.tapeId !== query.tapeId) return false
    if (query.level === 'attention' ? !['warn', 'error'].includes(record.level) : query.level !== null && record.level !== query.level) return false
    if (search && !searched.some((value) => value.includes(search))) return false
    if (query.after !== null) {
      const { time, kind, id } = query.after
      if (!(record.time < time || (record.time === time && (record.kind < kind || (record.kind === kind && record.id < id))))) return false
    }
    return true
  }).map(({ record }) => record).sort((left, right) => {
    if (left.time !== right.time) return left.time < right.time ? 1 : -1
    if (left.kind !== right.kind) return left.kind < right.kind ? 1 : -1
    return right.id - left.id
  })
  return { records: rows.slice(0, 100), more: rows.length > 100 }
}

describe('Records chronological page queries', () => {
  it('uses chronological indexes for every kind in the real newest-page plan', async () => {
    const { db } = await freshDatabase()
    growRecords(db, 0, 4000)
    const plan = pageQueryPlan(db).join('\n')
    for (const table of ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs']) {
      expect(plan).toContain(`USING INDEX idx_${table}_time_id`)
    }
    const after = { time: '2026-01-01T00:01:00.000Z', kind: 'log' as const, id: 50 }
    const cursorPlan = pageQueryPlan(db, recordsQuery({ after })).join('\n')
    for (const table of ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs']) {
      expect(cursorPlan).toContain(`SEARCH ${table} USING INDEX idx_${table}_time_id`)
    }
  })

  it('adds chronological indexes and execution facts to an existing current store while preserving its history', async () => {
    const { db, path } = await freshDatabase()
    growRecords(db, 0, 40)
    const before = readPage(db, recordsQuery())
    db.exec('DROP TABLE execution_facts')
    for (const table of ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs']) {
      db.exec(`DROP INDEX IF EXISTS idx_${table}_time_id`)
    }
    await createRecordsDatabase(path)
    expect(readPage(db, recordsQuery())).toEqual(before)
    for (const table of ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs']) {
      const column = table === 'logs' ? 'time' : 'started_at_utc'
      const index = db.prepare(`PRAGMA index_xinfo('idx_${table}_time_id')`).all() as Array<{ name: string | null; desc: number; key: number }>
      expect(index.filter((entry) => entry.key).map(({ name, desc }) => [name, desc])).toEqual([[column, 1], ['id', 1]])
    }
  })

  it('keeps time, kind and id cursor ties across pages before and after the indexes exist', async () => {
    const { db } = await freshDatabase()
    growRecords(db, 0, 260)
    // Put the entire first two pages on one shared time, making both the kind
    // and id ties matter at the cursor boundary.
    const time = '2026-01-01T00:00:00.000Z'
    for (const table of ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs']) {
      const column = table === 'logs' ? 'time' : 'started_at_utc'
      db.prepare(`UPDATE ${table} SET ${column} = ?`).run(time)
    }
    const all = () => {
      const found = []
      let query = recordsQuery()
      for (;;) {
        const page = readPage(db, query)
        found.push(...page.records)
        if (!page.more) break
        const last = page.records.at(-1)!
        query = recordsQuery({ after: { time: last.time, kind: last.kind, id: last.id } })
      }
      return found
    }
    const indexed = all()
    expect(indexed).toHaveLength(260)
    expect(new Set(indexed.map(({ kind, id }) => `${kind}:${id}`)).size).toBe(260)
    expect(indexed).toEqual([...indexed].sort((left, right) =>
      right.time.localeCompare(left.time) || right.kind.localeCompare(left.kind) || right.id - left.id,
    ))
    for (const table of ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs']) {
      db.exec(`DROP INDEX IF EXISTS idx_${table}_time_id`)
    }
    expect(all()).toEqual(indexed)
  })

  it('matches the unbounded reference through cursor ties and every filter', async () => {
    const { db } = await freshDatabase()
    growRecords(db, 0, 440)
    for (const table of ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs']) {
      db.exec(`UPDATE ${table} SET session = 'synthetic-launch-' || (id % 2), tape_id = 'synthetic-tape-' || (id % 3)`)
    }
    db.exec(`
      UPDATE logs SET level = CASE id % 3 WHEN 0 THEN 'warn' WHEN 1 THEN 'error' ELSE 'info' END, fields = '{"synthetic":"field_needle"}';
      UPDATE ai_calls SET request = 'REQUEST needle_', response = 'response 100%', error = CASE id % 2 WHEN 0 THEN 'synthetic error' ELSE NULL END;
      UPDATE ytdlp_runs SET exit_code = id % 2, stop_reason = CASE id % 4 WHEN 0 THEN 'cancel' ELSE NULL END, scan_id = 'scan_needle', stderr = 'run error';
      UPDATE ffmpeg_runs SET exit_code = id % 2, stop_reason = CASE id % 4 WHEN 0 THEN 'quit' ELSE NULL END, stderr = 'run error';
    `)
    for (const table of ['ytdlp_runs', 'ffmpeg_runs']) {
      db.exec(`INSERT INTO run_outputs SELECT '${table}', id, '${table}-' || id FROM ${table};
        INSERT INTO run_output_chunks SELECT session, '${table}-' || id, 'stderr', 0, 'run error' FROM ${table}`)
    }
    const facts = referenceRecords(db)
    const filters: Partial<RecordsQuery>[] = [
      {},
      ...(['log', 'ai-call', 'ytdlp-run', 'ffmpeg-run'] as const).map((kind) => ({ kind })),
      ...(['info', 'warn', 'error', 'attention'] as const).map((level) => ({ level })),
      { session: 'synthetic-launch-1' }, { session: 'missing launch' },
      { tapeId: 'synthetic-tape-1' }, { tapeId: 'missing tape' },
      ...['field_needle', 'needle_', '100%', 'scan_needle', 'run error', 'REQUEST', '  thumbnail  ', 'no match'].map((search) => ({ search })),
      { session: 'synthetic-launch-0', tapeId: 'synthetic-tape-2', level: 'attention' },
      { kind: 'ai-call', session: 'synthetic-launch-1', search: '100%' },
    ]
    for (const filter of filters) {
      let query = recordsQuery(filter)
      for (;;) {
        const expected = referencePage(facts, query)
        const page = readPage(db, query)
        expect(page, JSON.stringify(query)).toEqual(expected)
        if (!page.more) break
        const last = page.records.at(-1)!
        query = { ...query, after: { time: last.time, kind: last.kind, id: last.id } }
      }
      // Also start inside a timestamp group for each possible Records kind.
      for (const kind of ['log', 'ai-call', 'ytdlp-run', 'ffmpeg-run'] as const) {
        const query = recordsQuery({ ...filter, after: { time: '2026-01-01T00:00:13.000Z', kind, id: 7 } })
        expect(readPage(db, query), JSON.stringify(query)).toEqual(referencePage(facts, query))
      }
    }
  })
})


it('lists every launch and tape as complete sorted choices across reads', async () => {
  const { db } = await freshDatabase()
  growRecords(db, 0, 40)
  const tables = ['logs', 'ai_calls', 'ytdlp_runs', 'ffmpeg_runs']
  const oracle = () => {
    const sources = tables.map((table) => `SELECT session, tape_id, ${table === 'logs' ? 'time' : 'started_at_utc'} AS time FROM ${table}`).join(' UNION ALL ')
    const sessions = db.prepare(`SELECT DISTINCT session FROM (${sources}) ORDER BY session DESC`).all() as { session: string }[]
    const tapes = db.prepare(`SELECT tape_id AS tapeId, MAX(time) AS last FROM (${sources}) WHERE tape_id IS NOT NULL GROUP BY tape_id ORDER BY last DESC, tape_id ASC`).all() as { tapeId: string }[]
    return { sessions: sessions.map((row) => row.session), tapeIds: tapes.map((row) => row.tapeId) }
  }
  expect(readSources(db)).toEqual(oracle())
  growRecords(db, 40, 80)
  db.prepare("INSERT INTO logs (session, time, level, message, tape_id, fields) VALUES ('new-session', '2026-10-23T00:00:00.000Z', 'info', 'new fact', 'new-tape', '{}')").run()
  expect(readSources(db)).toEqual(oracle())
})

describe('bounded run output history', () => {
  const run = (db: DatabaseSync, kind: 'ytdlp-run' | 'ffmpeg-run', stdout: string, stderr = ''): number => {
    const table = kind === 'ytdlp-run' ? 'ytdlp_runs' : 'ffmpeg_runs'
    const columns = kind === 'ytdlp-run' ? 'session, kind, url, args, started_at_utc, ended_at_utc, stdout, stderr' : 'session, kind, args, started_at_utc, ended_at_utc, stdout, stderr'
    const values = kind === 'ytdlp-run' ? ['output-session', 'probe', 'https://example.test', '[]', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:01.000Z', stdout, stderr] : ['output-session', 'probe', '[]', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:01.000Z', stdout, stderr]
    return Number(db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${values.map(() => '?').join(',')})`).run(...values).lastInsertRowid)
  }

  it.each(['ytdlp-run', 'ffmpeg-run'] as const)('does not read obsolete inline %s output or silently accept a missing schema', async (kind) => {
    const { db } = await freshDatabase()
    const id = run(db, kind, 'obsolete inline evidence')
    expect(readDetail(db, kind, id)).toMatchObject({ stdout: '', stderr: '', outputStatus: 'unknown' })
    expect(readOutput(db, { kind, id, stream: 'stdout', page: 0 })).toEqual({ text: '', more: false })
    expect(readPage(db, recordsQuery({ kind, search: 'obsolete inline evidence' })).records).toEqual([])
    db.exec('DROP TABLE run_outputs')
    expect(() => readDetail(db, kind, id)).toThrow(/run_outputs/)
    const table = kind === 'ytdlp-run' ? 'ytdlp_runs' : 'ffmpeg_runs'
    expect(db.prepare(`SELECT stdout FROM ${table} WHERE id = ?`).get(id)).toEqual({ stdout: 'obsolete inline evidence' })
  })

  it.each([1, 2])('marks a missing output chunk at sequence %s as incomplete, including a missing final chunk', async (missing) => {
    const { db } = await freshDatabase()
    const id = run(db, 'ffmpeg-run', '')
    db.prepare("INSERT INTO run_outputs VALUES ('ffmpeg_runs', ?, 'gap')").run(id)
    expect(readDetail(db, 'ffmpeg-run', id)).toMatchObject({ outputStatus: 'unknown' })
    db.exec("INSERT INTO run_output_extents VALUES ('output-session', 'gap', 'stdout', 3), ('output-session', 'gap', 'stderr', 0)")
    const chunk = db.prepare("INSERT INTO run_output_chunks VALUES ('output-session', 'gap', 'stdout', ?, ?)")
    for (let sequence = 0; sequence < 3; sequence++) chunk.run(sequence, `chunk ${sequence}`)
    expect(readDetail(db, 'ffmpeg-run', id)).toMatchObject({ outputStatus: 'complete' })
    db.prepare("DELETE FROM run_output_chunks WHERE run_key = 'gap' AND sequence = ?").run(missing)
    expect(readDetail(db, 'ffmpeg-run', id)).toMatchObject({ outputStatus: 'incomplete' })
  })

  it.each(['ytdlp-run', 'ffmpeg-run'] as const)('reads mapped %s chunks exactly and searches later output while isolating session and stream', async (kind) => {
    const { db } = await freshDatabase()
    const id = run(db, kind, 'legacy stdout must be replaced', 'legacy stderr must be replaced')
    const table = kind === 'ytdlp-run' ? 'ytdlp_runs' : 'ffmpeg_runs'
    db.prepare('INSERT INTO run_outputs (record_table, record_id, run_key) VALUES (?, ?, ?)').run(table, id, 'output-key')
    const chunk = db.prepare('INSERT INTO run_output_chunks (session, run_key, stream, sequence, content) VALUES (?, ?, ?, ?, ?)')
    const pages = ['a'.repeat(32766) + '\u{1F600}', 'e\u0301'.repeat(16384), 'find-me-on-last-page']
    pages.forEach((text, sequence) => chunk.run('output-session', 'output-key', 'stdout', sequence, text))
    chunk.run('output-session', 'output-key', 'stderr', 0, 'warning')
    chunk.run('different-session', 'output-key', 'stdout', 0, 'other session secret')
    expect(readDetail(db, kind, id)).toMatchObject({ stdout: pages[0], stdoutMore: true, stderr: 'warning', stderrMore: false })
    const read = pages.map((text, page) => {
      const output = readOutput(db, { kind, id, stream: 'stdout', page })
      expect(output).toEqual({ text, more: page < pages.length - 1 })
      expect(output.text.length).toBeLessThanOrEqual(32768)
      return output.text
    })
    expect(read.join('')).toBe(pages.join(''))
    expect(readOutput(db, { kind, id, stream: 'stdout', page: 3 })).toEqual({ text: '', more: false })
    expect(readPage(db, recordsQuery({ kind, search: 'find-me-on-last-page' })).records.map((row) => row.id)).toEqual([id])
    expect(readPage(db, recordsQuery({ kind, search: 'other session secret' })).records).toEqual([])
    // Literal and ASCII case-insensitive matching survives page boundaries.
    expect(readPage(db, recordsQuery({ kind, search: '\u{1F600}e\u0301' })).records.map((row) => row.id)).toEqual([id])
    expect(readPage(db, recordsQuery({ kind, search: 'e\u0301FIND-ME' })).records.map((row) => row.id)).toEqual([id])
    expect(readPage(db, recordsQuery({ kind, search: 'last-pagewarning' })).records).toEqual([])
    expect(readPage(db, recordsQuery({ kind, search: 'warningaaa' })).records).toEqual([])
    // An arbitrarily long query may span more than two small persisted chunks.
    chunk.run('output-session', 'long-key', 'stdout', 0, 'First%_')
    chunk.run('output-session', 'long-key', 'stdout', 1, 'Middle')
    chunk.run('output-session', 'long-key', 'stdout', 2, 'Last')
    db.prepare('UPDATE run_outputs SET run_key = ? WHERE record_table = ? AND record_id = ?').run('long-key', table, id)
    expect(readPage(db, recordsQuery({ kind, search: 'FIRST%_MIDDLELAST' })).records.map((row) => row.id)).toEqual([id])
    expect(readPage(db, recordsQuery({ kind, search: 'firstanythingmiddlelast' })).records).toEqual([])
    db.prepare("DELETE FROM run_output_chunks WHERE run_key = 'long-key' AND sequence = 1").run()
    expect(readPage(db, recordsQuery({ kind, search: 'FIRST%_LAST' })).records).toEqual([])
    chunk.run('output-session', 'long-key', 'stdout', 1, 'Middle')
    db.prepare("DELETE FROM run_output_chunks WHERE run_key = 'long-key' AND sequence = 0").run()
    expect(readOutput(db, { kind, id, stream: 'stdout', page: 0 })).toEqual({ text: '', more: true })
    expect(readOutput(db, { kind, id, stream: 'stdout', page: 1 })).toEqual({ text: 'Middle', more: true })
    expect(readOutput(db, { kind, id, stream: 'stdout', page: 2 })).toEqual({ text: 'Last', more: false })

  })
})
