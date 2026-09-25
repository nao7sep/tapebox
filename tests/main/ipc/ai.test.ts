import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (req: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, (req) => fn({}, req))
    },
  },
}))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/store/session', () => ({
  getTape: (id: string) => ({ id, title: 'A Title', uploader: 'Someone', sidecarFilename: null }),
}))
vi.mock('@main/store/config', () => ({ getLibraryDir: () => '/library' }))
vi.mock('@main/core/sidecar', () => ({ readSidecar: vi.fn() }))

const seenSignals = vi.hoisted(() => [] as AbortSignal[])
vi.mock('@main/services/ai-client', () => ({
  // A provider that never answers: only an abort ends the request.
  generateSlug: (_opts: unknown, signal: AbortSignal) => {
    seenSignals.push(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Request was aborted.')), { once: true })
    })
  },
}))

const { registerAiHandlers } = await import('@main/ipc/ai')
registerAiHandlers()

describe('AI name suggestion', () => {
  it('stops a pending request when the renderer cancels it by id', async () => {
    const include = { title: true, uploader: false, description: false }
    const first = handlers.get('ai:generateSlug')!({ tapeId: 't1', include, requestId: 'r1' })
    const other = handlers.get('ai:generateSlug')!({ tapeId: 't1', include, requestId: 'r2' })
    await vi.waitFor(() => expect(seenSignals).toHaveLength(2))

    await handlers.get('ai:cancelSlug')!({ requestId: 'r1' })

    await expect(first).rejects.toThrow()
    expect(seenSignals[0]!.aborted).toBe(true)
    expect(seenSignals[1]!.aborted).toBe(false)

    await handlers.get('ai:cancelSlug')!({ requestId: 'r2' })
    await expect(other).rejects.toThrow()
  })
})
