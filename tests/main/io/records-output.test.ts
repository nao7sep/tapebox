import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { readDetail, readPage } from '@main/io/records-query'
import { recordsQuery } from '../../helpers/records-query-growth'
import type { RecordWriteRequest, RecordWriteResponse } from '@main/io/records-write-worker'

it.each([false, true])('retains output chunk identity and completed metadata mapping (fallback=%s)', async (textOnly) => {
  // The fallback case points the database at a folder, which cannot be opened.
  const root = await mkdtemp(join(tmpdir(), 'tapebox-record-output-'))
  const databasePath = join(root, 'records.sqlite3')
  const fallbackPath = join(root, 'fallback.log')
  const session = 'synthetic-session'
  const worker = new Worker(new URL('../../../src/main/io/records-write-worker.ts', import.meta.url), {
    workerData: { databasePath: textOnly ? root : databasePath, logsPath: root, fallbackPath, session },
  })
  const send = (request: RecordWriteRequest) => new Promise<RecordWriteResponse>((resolve, reject) => {
    worker.once('error', reject)
    worker.once('message', (response: RecordWriteResponse) => { worker.removeListener('error', reject); resolve(response) })
    worker.postMessage(request)
  })
  const chunk = { runKey: 'synthetic-key', stream: 'stderr' as const, sequence: 0, content: 'complete evidence \u{1F600}' }
  const chunkText = JSON.stringify({ record: 'run output', session, ...chunk })
  try {
    const chunkAck = await send({ id: 1, chunk, text: chunkText })
    expect(chunkAck.stored).toBe(false) // Only completed records notify list consumers.
    const metadata = await send({ id: 2, table: 'ffmpeg_runs', row: {
      tape_id: 'synthetic-tape', kind: 'probe', args: '[]', started_at_utc: '2026-01-01T00:00:00.000Z', ended_at_utc: '2026-01-01T00:00:01.000Z', exit_code: 1, signal: null, stop_reason: null, stdout: '', stderr: '',
    }, facts: { outputKey: chunk.runKey, outputChunks: { stdout: 0, stderr: 1 }, elapsedMs: 1000, succeeded: true }, text: JSON.stringify({ outputKey: chunk.runKey }) })
    expect(metadata.stored).toBe(!textOnly)
    if (textOnly) {
      const lines = (await readFile(fallbackPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(lines).toContainEqual(JSON.parse(chunkText))
      expect(lines).toContainEqual({ outputKey: chunk.runKey })
    } else {
      const db = new DatabaseSync(databasePath)
      try {
        expect(db.prepare('SELECT session, run_key, stream, sequence, content FROM run_output_chunks').get()).toMatchObject({ session, run_key: chunk.runKey, stream: chunk.stream, sequence: 0, content: chunk.content })
        expect(db.prepare('SELECT * FROM run_outputs').get()).toMatchObject({ record_table: 'ffmpeg_runs', record_id: 1, run_key: chunk.runKey })
        expect(readDetail(db, 'ffmpeg-run', 1)).toMatchObject({ outputStatus: 'complete' })
        expect(db.prepare('SELECT * FROM execution_facts').get()).toMatchObject({ record_table: 'ffmpeg_runs', record_id: 1, elapsed_ms: 1000, succeeded: 1 })
      } finally { db.close() }
    }
  } finally { await worker.terminate(); await rm(root, { recursive: true, force: true }) }
})

// Real worker fallback must not turn missing diagnostics into a failed tool run.
it.each([1, 2])('reports incomplete output after the writer rejects sequence %s', async (missing) => {
  const root = await mkdtemp(join(tmpdir(), 'tapebox-record-gap-'))
  const databasePath = join(root, 'records.sqlite3')
  const worker = new Worker(new URL('../../../src/main/io/records-write-worker.ts', import.meta.url), {
    workerData: { databasePath, logsPath: root, fallbackPath: join(root, 'fallback.log'), session: 'gap-session' },
  })
  const send = (request: RecordWriteRequest) => new Promise<RecordWriteResponse>((resolve, reject) => {
    worker.once('error', reject)
    worker.once('message', (response: RecordWriteResponse) => { worker.removeListener('error', reject); resolve(response) })
    worker.postMessage(request)
  })
  let db: DatabaseSync | undefined
  try {
    await send({ id: 1, chunk: { runKey: 'gap', stream: 'stdout', sequence: 0, content: 'before' }, text: 'before' })
    db = new DatabaseSync(databasePath)
    db.exec(`CREATE TRIGGER reject_chunk BEFORE INSERT ON run_output_chunks WHEN NEW.sequence = ${missing} BEGIN SELECT RAISE(ABORT, 'fixture rejected chunk'); END`)
    for (const sequence of [1, 2]) await send({ id: sequence + 1, chunk: { runKey: 'gap', stream: 'stdout', sequence, content: sequence === 1 ? 'middle' : 'after' }, text: 'fallback evidence' })
    const ack = await send({ id: 4, table: 'ffmpeg_runs', row: {
      tape_id: null, kind: 'probe', args: '[]', started_at_utc: '2026-01-01T00:00:00.000Z', ended_at_utc: '2026-01-01T00:00:01.000Z', exit_code: 0, signal: null, stop_reason: null, stdout: '', stderr: '',
    }, facts: { outputKey: 'gap', outputChunks: { stdout: 3, stderr: 0 }, succeeded: true }, text: 'completed run' })
    expect(ack.stored).toBe(true)
    expect(readDetail(db, 'ffmpeg-run', 1)).toMatchObject({ outputStatus: 'incomplete', level: 'info' })
    expect(readPage(db, recordsQuery({ search: 'beforeafter' })).records).toEqual([])
    expect(await readFile(join(root, 'fallback.log'), 'utf8')).toContain('fallback evidence')
  } finally { db?.close(); await worker.terminate(); await rm(root, { recursive: true, force: true }) }
})
