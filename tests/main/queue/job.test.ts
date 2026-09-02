import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Job, type JobDeps } from '@main/queue/job'
import type { ProbeVideo } from '@main/services/ytdlp'
import type { Tape } from '@shared/domain'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-06-26T00:00:00.000Z'
const LIBRARY_DIR = join(tmpdir(), 'tapebox-job-library')

function tape(over: Partial<Tape>): Tape {
  return {
    id: 't1',
    sourceUrl: 'http://example.com/v',
    state: 'queued',
    addedAtUtc: T0,
    sourceId: null,
    extractor: null,
    title: null,
    uploader: null,
    durationSeconds: null,
    chapterCount: 0,
    probedAtUtc: null,
    filename: null,
    sidecarFilename: null,
    thumbnailFilename: null,
    downloadStartedAtUtc: null,
    downloadedAtUtc: null,
    name: null,
    renamedAtUtc: null,
    archivedAtUtc: null,
    boxId: null,
    order: 0,
    pausedAtUtc: null,
    failedAtUtc: null,
    lastError: null,
    ...over,
  }
}

const video: ProbeVideo = {
  kind: 'video',
  id: 'vid1',
  extractor: 'youtube',
  title: 'A Video',
  uploader: 'Someone',
  description: null,
  duration: 12,
  chapters: null,
}

function makeDeps(opts: {
  initial?: Tape[]
  probe?: JobDeps['ytdlp']['probe']
  download?: JobDeps['ytdlp']['download']
}): { deps: JobDeps; tapes: Map<string, Tape>; emits: string[]; payloads: unknown[]; errors: unknown[] } {
  const tapes = new Map<string, Tape>((opts.initial ?? []).map((t) => [t.id, t]))
  const emits: string[] = []
  const payloads: unknown[] = []
  const errors: unknown[] = []
  const noop = (): void => {}

  const deps: JobDeps = {
    ytdlp: {
      probe: opts.probe ?? (async () => ({ kind: 'page' })),
      download:
        opts.download ?? (async () => ({ mediaPath: join(LIBRARY_DIR, 't1.mp4'), infoJsonPath: join(LIBRARY_DIR, 't1.info.json') })),
      findThumbnail: async () => join(LIBRARY_DIR, 't1.webp'),
    },
    ffmpeg: {
      probeMedia: async () => ({
        width: null,
        height: null,
        fps: null,
        vcodec: null,
        acodec: null,
        durationSeconds: null,
        bitrateKbps: null,
      }),
      saveThumbnailJpeg: async () => 't1.jpg',
    },
    sidecar: { finalize: async () => {} },
    session: {
      getTape: (id) => tapes.get(id),
      getTapes: () => [...tapes.values()],
      upsertTape: (t) => {
        tapes.set(t.id, t)
      },
    },
    getLibraryDir: () => LIBRARY_DIR,
    emit: ((channel: string, payload: unknown) => {
      emits.push(channel)
      payloads.push(payload)
    }) as JobDeps['emit'],
    log: { info: noop, warn: noop, error: ((_message: string, fields: unknown) => errors.push(fields)) as JobDeps['log']['error'] },
    now: () => T1,
  }
  return { deps, tapes, emits, payloads, errors }
}

describe('Job lifecycle (driven with fakes)', () => {
  it('moves a page result to listing and downloads nothing', async () => {
    const t = tape({ id: 't1' })
    const { deps, tapes, emits } = makeDeps({ initial: [t], probe: async () => ({ kind: 'page' }) })
    await new Job(t, deps).run()
    expect(tapes.get('t1')!.state).toBe('listing')
    expect(emits).not.toContain('tapes:completed')
  })

  it('probes a video to ready, then downloads and finalizes it', async () => {
    const t = tape({ id: 't1' })
    const { deps, tapes, emits } = makeDeps({ initial: [t], probe: async () => video })
    await new Job(t, deps).run()
    const final = tapes.get('t1')!
    expect(final.state).toBe('downloaded')
    expect(final.sourceId).toBe('vid1')
    expect(final.extractor).toBe('youtube')
    expect(final.filename).toBe('t1.mp4')
    expect(final.sidecarFilename).toBe('t1.json')
    expect(final.thumbnailFilename).toBe('t1.jpg')
    expect(emits).toContain('tapes:completed')
  })

  it('rejects a probe whose (extractor, id) duplicates an existing tape', async () => {
    const t = tape({ id: 't1' })
    const existing = tape({ id: 't0', sourceId: 'vid1', extractor: 'youtube', state: 'downloaded' })
    const { deps, tapes } = makeDeps({ initial: [existing, t], probe: async () => video })
    await new Job(t, deps).run()
    expect(tapes.get('t1')!.state).toBe('failed')
    expect(tapes.get('t1')!.failureCode).toBe('duplicate')
    expect(tapes.get('t1')!.lastError).toMatch(/already in the library/)
  })

  it('lands a cancelled run in paused, not failed', async () => {
    const t = tape({ id: 't1' })
    const { deps, tapes } = makeDeps({
      initial: [t],
      probe: async (_url, signal) => {
        if (signal.aborted) throw new Error('aborted')
        return { kind: 'page' }
      },
    })
    const job = new Job(t, deps)
    await job.cancel() // sets the cancel flag and aborts before run starts
    await job.run() // probe sees the aborted signal, throws; the catch maps it to paused
    expect(tapes.get('t1')!.state).toBe('paused')
    expect(tapes.get('t1')!.lastError).toBeNull()
  })

  it('keeps hostile process diagnostics out of persisted and emitted presentation', async () => {
    const hostile = 'EACCES Error invoking remote method IPC /private/tmp/HOSTILE-SENTINEL'
    const t = tape({ id: 't1' })
    const { deps, tapes, emits, payloads, errors } = makeDeps({
      initial: [t],
      probe: async () => { throw new Error(hostile, { cause: new TypeError('root cause') }) },
    })

    await new Job(t, deps).run()

    const failed = tapes.get('t1')!
    expect(failed.failureCode).toBe('download')
    expect(failed.lastError).not.toContain('HOSTILE-SENTINEL')
    const eventIndex = emits.lastIndexOf('tapes:failed')
    expect(payloads[eventIndex]).toEqual({ tapeId: 't1', code: 'download' })
    expect(JSON.stringify(payloads)).not.toContain('HOSTILE-SENTINEL')
    expect(JSON.stringify(errors)).toContain('HOSTILE-SENTINEL')
    expect(JSON.stringify(errors)).toContain('root cause')
  })
})
