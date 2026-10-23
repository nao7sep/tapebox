import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import type { RecordWriteRequest, RecordWriteResponse } from '@main/io/records-write-worker'

it.each([false, true])('retains output chunk identity and completed metadata mapping (fallback=%s)', async (textOnly) => {
  const root = await mkdtemp(join(tmpdir(), 'tapebox-record-output-'))
  const databasePath = join(root, 'records.sqlite3')
  const fallbackPath = join(root, 'fallback.log')
  const session = 'synthetic-session'
  const worker = new Worker(new URL('../../../src/main/io/records-write-worker.ts', import.meta.url), {
    workerData: { databasePath, logsPath: root, fallbackPath, session, textOnly },
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
    }, facts: { outputKey: chunk.runKey, elapsedMs: 1000, succeeded: true }, text: JSON.stringify({ outputKey: chunk.runKey }) })
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
        expect(db.prepare('SELECT * FROM execution_facts').get()).toMatchObject({ record_table: 'ffmpeg_runs', record_id: 1, elapsed_ms: 1000, succeeded: 1 })
      } finally { db.close() }
    }
  } finally { await worker.terminate(); await rm(root, { recursive: true, force: true }) }
})
