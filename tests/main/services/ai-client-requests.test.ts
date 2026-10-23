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

  it('honours Retry-After within the automatic wait budget and stops after three attempts', async () => {
    vi.useFakeTimers()
    const error = new OpenAI.APIError(503, { message: 'busy' }, undefined, new Headers({ 'retry-after': '30' }))
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

  it.each(['90', new Date(Date.now() + 120_000).toUTCString()])('returns the provider error without an early resend for Retry-After %s', async (value) => {
    vi.useFakeTimers()
    create.mockRejectedValue(new OpenAI.APIError(429, { message: 'busy' }, undefined, new Headers({ 'retry-after': value })))
    await expect(generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)).rejects.toThrow('busy')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(create).toHaveBeenCalledOnce()
  })

  it('uses ordinary backoff for an invalid Retry-After', async () => {
    vi.useFakeTimers()
    create.mockRejectedValueOnce(new OpenAI.APIError(503, { message: 'busy' }, undefined, new Headers({ 'retry-after': 'invalid' })))
    const outcome = generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(create).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await expect(outcome).resolves.toBe('a-name')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('records each attempt whole, the request as sent with its headers masked and the provider\'s error body', async () => {
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
    // Every header is kept by name; the key itself never reaches the record.
    expect(Object.keys(sent.headers).sort()).toEqual(Object.keys(Object.fromEntries(new Headers(init.headers))).sort())
    expect(sent.headers.authorization).toBe('Bearer [REDACTED]')
    expect(new Headers(init.headers).get('authorization'), 'the request itself was sent as built').toBe('Bearer mock-key')
    for (const { row } of rows) expect(JSON.stringify(row)).not.toContain('mock-key')
    expect(sent.body).toMatchObject({ model: 'gpt-6-luna', messages: [expect.objectContaining({ role: 'user' })] })
    expect(JSON.parse(rows[1]!.row.response)).toEqual(answer)
    expect(rows[1]!.row).toMatchObject({ status: null, error: null })
  })

  it('records monotonic attempt duration when the wall clock moves backwards', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T10:00:00Z'))
    let monotonic = 100
    const now = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    create.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2026-10-23T09:00:00Z'))
      monotonic = 350
      return { choices: [{ finish_reason: 'stop', message: { content: '{"slug":"a-name"}' } }] }
    })
    try {
      await generateSlug({ tapeId: 't1', title: 'Title' }, new AbortController().signal)
      expect(writeRecord.mock.calls[0]![5]).toEqual({ elapsedMs: 250, succeeded: true })
      expect(writeRecord.mock.calls[0]![1]).toMatchObject({ started_at_utc: '2026-10-23T10:00:00.000Z', ended_at_utc: '2026-10-23T09:00:00.000Z' })
    } finally { now.mockRestore() }
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
