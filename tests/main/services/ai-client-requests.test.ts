import OpenAI from 'openai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { SLUG_RESPONSE_FORMAT } from '@shared/model-routing'

const { create, constructors, writeRecord, state } = vi.hoisted(() => ({
  create: vi.fn(), constructors: vi.fn(), writeRecord: vi.fn(),
  state: { settings: {} as ReturnType<typeof defaultSettings>, overHttp: false },
}))
vi.mock('openai', async (original) => {
  const module = await original<typeof import('openai')>()
  return { ...module, default: class extends module.default {
    constructor(options: ConstructorParameters<typeof module.default>[0]) {
      super(options)
      constructors(options)
      if (!state.overHttp) this.chat.completions.create = create
    }
  } }
})
vi.mock('@main/store/config', () => ({ getSettings: () => state.settings }))
vi.mock('@main/services/api-keys', () => ({ resolveApiKey: async () => 'mock-key' }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@main/io/records', () => ({ writeRecord }))
import { generateSlug } from '@main/services/ai-client'

beforeEach(() => {
  vi.clearAllMocks()
  state.settings = defaultSettings()
  state.overHttp = false
  create.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: '{"slug":"a-name"}' } }] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('slug request routing', () => {
  it('uses the model branch behind a proxy and the plain request for local ids', async () => {
    state.settings['openai.endpoint'] = 'https://proxy.example/v1'
    await expect(generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)).resolves.toBe('a-name')
    expect(constructors).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://proxy.example/v1', maxRetries: 0 }))
    expect(Object.keys(create.mock.calls[0]![0]).sort()).toEqual(['messages', 'model', 'reasoning_effort', 'response_format'])
    expect(create.mock.calls[0]![0]).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'none', response_format: SLUG_RESPONSE_FORMAT })
    state.settings['openai.slug'] = 'local-model'
    await generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)
    expect(Object.keys(create.mock.calls[1]![0]).sort()).toEqual(['messages', 'model', 'response_format'])
    expect(create.mock.calls[1]![0]).toMatchObject({ response_format: SLUG_RESPONSE_FORMAT })
  })

  it('sends the role\'s thinking, or the model\'s default when the model does not list it', async () => {
    state.settings['openai.thinking.slug'] = 'high'
    await generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)
    expect(create.mock.calls[0]![0]).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'high' })
    state.settings['openai.slug'] = 'gpt-6.1-sol'
    state.settings['openai.thinking.slug'] = 'none'
    await generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)
    expect(create.mock.calls[1]![0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'medium' })
  })

  it('reads the slug out of the strict schema\'s answer', async () => {
    create.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: '{"slug":"  morning-walk  "}' } }] })
    await expect(generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)).resolves.toBe('morning-walk')
  })

  it('honours the capped Retry-After and stops after three attempts', async () => {
    vi.useFakeTimers()
    const error = new OpenAI.APIError(503, { message: 'busy' }, undefined, new Headers({ 'retry-after': '90' }))
    create.mockRejectedValue(error)
    const outcome = generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal).catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(create).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(create).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(create).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(create).toHaveBeenCalledTimes(3)
    expect((await outcome).message).toContain('busy')
  })

  it('records each attempt whole, the request as sent with its headers and the provider\'s error body', async () => {
    state.overHttp = true
    const answer = { choices: [{ finish_reason: 'stop', message: { content: '{"slug":"a-name"}' } }], usage: { total_tokens: 9 } }
    const json = (body: object, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: { message: 'provider reason' } }, 500))
      .mockResolvedValueOnce(json(answer, 200))
    vi.stubGlobal('fetch', fetch)
    await expect(generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)).rejects.toThrow()
    await generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)

    const rows = writeRecord.mock.calls.map(([table, row]) => ({ table, row }))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      table: 'ai_calls',
      row: { tape_id: 't1', endpoint: state.settings['openai.endpoint'], model: 'gpt-6-luna', status: 500 },
    })
    expect(JSON.parse(rows[0]!.row.response)).toEqual({ message: 'provider reason' })
    expect(JSON.parse(rows[0]!.row.error)).toMatchObject({ message: expect.stringContaining('provider reason') })
    const [url, init] = fetch.mock.calls[1]!
    const sent = JSON.parse(rows[1]!.row.request)
    expect(sent).toMatchObject({ method: 'POST', url: String(url), body: JSON.parse(init.body) })
    expect(sent.headers).toEqual(Object.fromEntries(new Headers(init.headers)))
    expect(sent.headers.authorization).toBe('Bearer mock-key')
    expect(sent.body).toMatchObject({ model: 'gpt-6-luna', messages: [expect.objectContaining({ role: 'user' })] })
    expect(JSON.parse(rows[1]!.row.response)).toEqual(answer)
    expect(rows[1]!.row).toMatchObject({ status: null, error: null })
  })

  it('records the parameters the app built, without headers or the key, for an attempt that never left', async () => {
    create.mockRejectedValue(new OpenAI.APIConnectionError({ message: 'never sent' }))
    await expect(generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)).rejects.toThrow()

    expect(writeRecord).toHaveBeenCalledOnce()
    const [table, row] = writeRecord.mock.calls[0]!
    expect(table).toBe('ai_calls')
    expect(JSON.parse(row.request)).toEqual(create.mock.calls[0]![0])
    expect(row.request).not.toMatch(/headers|authorization|mock-key/i)
  })

  it.each([500, 502, 504])('reports HTTP %s immediately for manual retry', async (status) => {
    create.mockRejectedValue(new OpenAI.APIError(status, { message: 'provider reason' }, undefined, new Headers()))
    await expect(generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)).rejects.toThrow('provider reason')
    expect(create).toHaveBeenCalledOnce()
  })
})
