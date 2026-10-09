import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Job, type JobDeps } from '@main/queue/job'
import { StopRequest } from '@main/stop-request'
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
    failureCode: null,
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
  persistSucceeds?: boolean
  finished?: JobDeps['findFinishedBundle']
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
    findFinishedBundle: opts.finished ?? (async () => ({ status: 'none' })),
    session: {
      getTape: (id) => tapes.get(id),
      getTapes: () => [...tapes.values()],
      upsertTape: (t) => {
        tapes.set(t.id, t)
      },
      persistNow: async () => {
        // Kept in the event sequence (with a matching payload slot) so tests can
        // see whether a commit came before an event.
        emits.push(`persist:${[...tapes.values()].map((t) => t.state).join(',')}`)
        payloads.push(null)
        return opts.persistSucceeds ?? true
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
    // The downloaded row is durable before success is reported.
    expect(emits.indexOf('persist:downloaded')).toBeGreaterThanOrEqual(0)
    expect(emits.indexOf('persist:downloaded')).toBeLessThan(emits.indexOf('tapes:completed'))
  })

  it('keeps a finished download as downloaded when the catalog write fails', async () => {
    const t = tape({ id: 't1' })
    const { deps, tapes, emits } = makeDeps({ initial: [t], probe: async () => video, persistSucceeds: false })
    await new Job(t, deps).run()
    const final = tapes.get('t1')!
    expect(final.state).toBe('downloaded')
    expect(final.failureCode).toBeNull()
    expect(final.filename).toBe('t1.mp4')
    expect(emits).toContain('tapes:completed')
    expect(emits).not.toContain('tapes:failed')
  })

  it('keeps a finished download as downloaded when telling the window throws', async () => {
    const t = tape({ id: 't1' })
    const { deps, tapes, emits, errors } = makeDeps({ initial: [t], probe: async () => video })
    const send = deps.emit
    deps.emit = ((channel: string, payload: unknown) => {
      if (channel === 'tapes:updated' && (payload as Tape).state === 'downloaded') throw new Error('window gone')
      send(channel as never, payload as never)
    }) as JobDeps['emit']
    await new Job(t, deps).run()
    const final = tapes.get('t1')!
    expect(final).toMatchObject({ state: 'downloaded', failureCode: null, filename: 't1.mp4', sidecarFilename: 't1.json' })
    expect(emits, 'the downloaded row was committed before the send').toContain('persist:downloaded')
    expect(emits).not.toContain('tapes:failed')
    expect(errors).toEqual([expect.objectContaining({ tapeId: 't1', error: expect.objectContaining({ message: 'window gone' }) })])
  })

  it('adopts a download that finished before its catalog commit, without probing or downloading', async () => {
    const t = tape({ id: 't1', sourceId: 'vid1', extractor: 'youtube', title: 'A Video' })
    let probed = false
    let downloaded = false
    const { deps, tapes, emits } = makeDeps({
      initial: [t],
      probe: async () => { probed = true; return video },
      download: async () => { downloaded = true; throw new Error('a new attempt would clear the stem') },
      finished: async () => ({
        status: 'found',
        move: { state: 'downloaded', failureCode: null, filename: 't1.mp4', sidecarFilename: 't1.json', thumbnailFilename: 't1.jpg', downloadedAtUtc: T0 },
      }),
    })
    await new Job(t, deps).run()
    expect(probed).toBe(false)
    expect(downloaded).toBe(false)
    expect(tapes.get('t1')).toMatchObject({ state: 'downloaded', filename: 't1.mp4', downloadedAtUtc: T0, title: 'A Video' })
    expect(emits.indexOf('persist:downloaded')).toBeGreaterThanOrEqual(0)
    expect(emits.indexOf('persist:downloaded')).toBeLessThan(emits.indexOf('tapes:completed'))
  })

  it('fails without downloading over a finished bundle it cannot adopt', async () => {
    const t = tape({ id: 't1' })
    let downloaded = false
    const { deps, tapes, emits, errors } = makeDeps({
      initial: [t],
      probe: async () => video,
      download: async () => { downloaded = true; throw new Error('a new attempt would clear the stem') },
      finished: async () => ({ status: 'unusable', reason: 'import.sidecarNewer' }),
    })
    await new Job(t, deps).run()
    expect(downloaded).toBe(false)
    expect(tapes.get('t1')).toMatchObject({ state: 'failed', failureCode: 'download' })
    expect(emits).toContain('tapes:failed')
    expect(errors).toEqual([expect.objectContaining({ tapeId: 't1', reason: 'import.sidecarNewer' })])
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

  it('records one probe time for a duplicate and its failure', async () => {
    const t = tape({ id: 't1' })
    const existing = tape({ id: 't0', sourceId: 'vid1', extractor: 'youtube', state: 'downloaded' })
    const { deps, tapes } = makeDeps({ initial: [existing, t], probe: async () => video })
    let tick = 0
    deps.now = () => `2026-06-26T00:00:0${tick++}.000Z`
    await new Job(t, deps).run()
    const failed = tapes.get('t1')!
    expect(failed.failedAtUtc).not.toBeNull()
    expect(failed.failedAtUtc).toBe(failed.probedAtUtc)
  })

  it('writes the same download time to the sidecar and the catalog', async () => {
    const t = tape({ id: 't1' })
    const { deps, tapes } = makeDeps({ initial: [t], probe: async () => video })
    let tick = 0
    deps.now = () => `2026-06-26T00:00:0${tick++}.000Z`
    let sidecarDownloadedAt: string | null = null
    deps.sidecar.finalize = async (opts) => { sidecarDownloadedAt = opts.tapeboxAdditions.downloadedAtUtc }
    await new Job(t, deps).run()
    expect(sidecarDownloadedAt).not.toBeNull()
    expect(tapes.get('t1')!.downloadedAtUtc).toBe(sidecarDownloadedAt)
  })

  it('clears an earlier pause or failure time once the tape moves on', async () => {
    const t = tape({ id: 't1', pausedAtUtc: T0, failedAtUtc: T0 })
    const { deps, tapes } = makeDeps({ initial: [t], probe: async () => video })
    await new Job(t, deps).run()
    expect(tapes.get('t1')).toMatchObject({ state: 'downloaded', pausedAtUtc: null, failedAtUtc: null })
  })

  it('lands a cancelled run in paused, not failed', async () => {
    const t = tape({ id: 't1' })
    const { deps, tapes } = makeDeps({
      initial: [t],
      probe: async (_tapeId, _url, signal) => {
        reasons.push(signal.reason)
        if (signal.aborted) throw new Error('aborted')
        return { kind: 'page' }
      },
    })
    const reasons: unknown[] = []
    const job = new Job(t, deps)
    await job.cancel() // sets the cancel flag and aborts before run starts
    await job.run() // probe sees the aborted signal, throws; the catch maps it to paused
    expect(reasons[0]).toBeInstanceOf(StopRequest)
    expect((reasons[0] as StopRequest).by).toBe('cancel')
    expect(tapes.get('t1')!.state).toBe('paused')
    expect(tapes.get('t1')!.pausedAtUtc).toBe(T1)
    expect(tapes.get('t1')!.lastError).toBeNull()
  })

  it('leaves a run stopped at quit in its in-flight state so the next launch resumes it', async () => {
    const t = tape({ id: 't1' })
    const { deps, tapes, emits } = makeDeps({
      initial: [t],
      probe: async () => video,
      download: (opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          stoppedBy = (opts.signal.reason as StopRequest).by
          reject(new Error('aborted'))
        }, { once: true })
      }),
    })
    let stoppedBy: string | null = null
    const job = new Job(t, deps)
    const run = job.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tapes.get('t1')!.state).toBe('downloading')
    await job.stop()
    await run
    expect(stoppedBy).toBe('quit')
    expect(tapes.get('t1')!.state).toBe('downloading')
    expect(tapes.get('t1')!.pausedAtUtc).toBeNull()
    expect(emits).not.toContain('tapes:failed')
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
