import OpenAI from 'openai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'

const { create, constructors, state } = vi.hoisted(() => ({
  create: vi.fn(), constructors: vi.fn(), state: { settings: {} as ReturnType<typeof defaultSettings> },
}))
vi.mock('openai', async (original) => {
  const module = await original<typeof import('openai')>()
  return { ...module, default: class extends module.default {
    constructor(options: ConstructorParameters<typeof module.default>[0]) {
      super(options)
      constructors(options)
      this.chat.completions.create = create
    }
  } }
})
vi.mock('@main/store/config', () => ({ getSettings: () => state.settings }))
vi.mock('@main/services/api-keys', () => ({ resolveApiKey: async () => 'mock-key' }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { generateSlug } from '@main/services/ai-client'

beforeEach(() => {
  vi.clearAllMocks()
  state.settings = defaultSettings()
  create.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: 'a-name' } }] })
})
afterEach(() => vi.useRealTimers())

describe('slug request routing', () => {
  it('uses the model branch behind a proxy and the plain request for local ids', async () => {
    state.settings['openai.endpoint'] = 'https://proxy.example/v1'
    await expect(generateSlug({ title: 'Title' }, new AbortController().signal)).resolves.toBe('a-name')
    expect(constructors).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://proxy.example/v1', maxRetries: 0 }))
    expect(Object.keys(create.mock.calls[0]![0]).sort()).toEqual(['messages', 'model', 'reasoning_effort'])
    expect(create.mock.calls[0]![0]).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'none' })
    state.settings['openai.slug'] = 'local-model'
    await generateSlug({ title: 'Title' }, new AbortController().signal)
    expect(Object.keys(create.mock.calls[1]![0]).sort()).toEqual(['messages', 'model'])
  })

  it('sends the role\'s thinking, or the model\'s default when the model does not list it', async () => {
    state.settings['openai.thinking.slug'] = 'high'
    await generateSlug({ title: 'Title' }, new AbortController().signal)
    expect(create.mock.calls[0]![0]).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'high' })
    state.settings['openai.slug'] = 'gpt-6.1-sol'
    state.settings['openai.thinking.slug'] = 'none'
    await generateSlug({ title: 'Title' }, new AbortController().signal)
    expect(create.mock.calls[1]![0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'low' })
  })

  it('honours the capped Retry-After and stops after three attempts', async () => {
    vi.useFakeTimers()
    const error = new OpenAI.APIError(503, { message: 'busy' }, undefined, new Headers({ 'retry-after': '90' }))
    create.mockRejectedValue(error)
    const outcome = generateSlug({ title: 'Title' }, new AbortController().signal).catch((error) => error)
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

  it.each([500, 502, 504])('reports HTTP %s immediately for manual retry', async (status) => {
    create.mockRejectedValue(new OpenAI.APIError(status, { message: 'provider reason' }, undefined, new Headers()))
    await expect(generateSlug({ title: 'Title' }, new AbortController().signal)).rejects.toThrow('provider reason')
    expect(create).toHaveBeenCalledOnce()
  })
})
