import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as { signal?: AbortSignal }[])
vi.mock('openai', () => {
  class APIError extends Error {
    status: number | undefined
    constructor(status: number | undefined) {
      super(`status ${status}`)
      this.status = status
    }
  }
  class OpenAI {
    static APIError = APIError
    chat = {
      completions: {
        create: (_body: unknown, options: { signal?: AbortSignal }) => {
          calls.push(options)
          // A 503 is retryable; the retry wait must end as soon as the caller aborts.
          return Promise.reject(new APIError(503))
        },
      },
    }
  }
  return { default: OpenAI }
})
vi.mock('@main/store/config', () => ({
  getSettings: () => ({ ai: { baseUrl: 'https://ai.example', model: 'm' }, prompts: { slug: '{title}' } }),
}))
vi.mock('@main/services/api-keys', () => ({ resolveApiKey: async () => 'test-key' }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { generateSlug } = await import('@main/services/ai-client')

describe('generateSlug cancellation', () => {
  it('passes the caller signal to the request and stops retrying once it aborts', async () => {
    const controller = new AbortController()
    const pending = generateSlug({ title: 'A Title' }, controller.signal)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.signal).toBe(controller.signal)

    const started = Date.now()
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    // Without the signal, the first retry wait alone is 2 s.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls).toHaveLength(1)
  })
})
