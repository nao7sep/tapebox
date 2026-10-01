import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { list, key, options, log } = vi.hoisted(() => ({
  list: vi.fn(), key: vi.fn(), options: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('openai', () => ({ default: class {
  constructor(opts: unknown) { options(opts) }
  models = { list }
} }))
vi.mock('@main/services/api-keys', () => ({ resolveApiKey: key }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
let dir: string
let modelList: typeof import('@main/services/model-lists').modelList
const request = { endpoint: 'https://endpoint.example/v1', force: false }
const signal = () => new AbortController().signal
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'tapebox-model-list-'))
  vi.stubEnv('TAPEBOX_DATA_DIR', dir)
  key.mockResolvedValue('mock-key')
  list.mockResolvedValue({ data: [{ id: 'gpt-future' }, { id: 'embedding-model' }, { id: 'gpt-image-2' }, { id: 'gpt-future' }] })
  ;({ modelList } = await import('@main/services/model-lists'))
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })

describe('settings model-list refresh', () => {
  it('filters, persists provider facts, and refreshes only daily or manually', async () => {
    expect(await modelList(request, signal())).toEqual(['gpt-future'])
    const saved = JSON.parse(await readFile(join(dir, 'model-lists.json'), 'utf8'))
    expect(saved).toEqual({ openai: { fetchedAtUtc: expect.stringMatching(/\.\d{3}Z$/), ids: ['gpt-future'] } })
    expect(await readdir(dir)).toEqual(['model-lists.json'])
    await modelList(request, signal())
    expect(list).toHaveBeenCalledOnce()
    await modelList({ ...request, force: true }, signal())
    expect(list).toHaveBeenCalledTimes(2)
    expect(options).toHaveBeenCalledWith(expect.objectContaining({ baseURL: request.endpoint, maxRetries: 0, timeout: 30_000 }))
  })

  it('uses recent facts across a restart without resolving credentials', async () => {
    await writeFile(join(dir, 'model-lists.json'), JSON.stringify({ openai: { fetchedAtUtc: new Date().toISOString(), ids: ['gpt-cached'] } }))
    expect(await modelList(request, signal())).toEqual(['gpt-cached'])
    expect(key).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('keeps previous facts on failure, logs once, and does not auto-fetch again that day', async () => {
    const saved = { openai: { fetchedAtUtc: '2020-01-01T00:00:00.000Z', ids: ['gpt-cached'] } }
    await writeFile(join(dir, 'model-lists.json'), JSON.stringify(saved))
    list.mockRejectedValue(new Error('provider unavailable'))
    expect(await modelList(request, signal())).toEqual(['gpt-cached'])
    expect(await modelList(request, signal())).toEqual(['gpt-cached'])
    expect(list).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(dir, 'model-lists.json'), 'utf8'))).toEqual(saved)
  })

  it('writes nothing without a key and shares simultaneous refreshes', async () => {
    key.mockResolvedValueOnce(null)
    expect(await modelList(request, signal())).toEqual([])
    expect(list).not.toHaveBeenCalled()
    expect(await readdir(dir)).toEqual([])
    const a = modelList(request, signal())
    const b = modelList(request, signal())
    expect(a).toBe(b)
    await Promise.all([a, b])
    expect(list).toHaveBeenCalledOnce()
  })

  it('does not persist an abandoned fetch result', async () => {
    const controller = new AbortController()
    list.mockImplementation(async () => { controller.abort(); return { data: [{ id: 'gpt-future' }] } })
    expect(await modelList(request, controller.signal)).toEqual([])
    expect(await readdir(dir)).toEqual([])
    expect(log.warn).not.toHaveBeenCalled()
  })
})
