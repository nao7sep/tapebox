import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { aiRequestFailure, completionText, isRetryableAiError, aiRetryAfterMs } from '@main/services/ai-client'
import { UserFacingError } from '@main/user-facing-error'

describe('completionText', () => {
  it('returns a complete accepted response', () => {
    expect(completionText({ finish_reason: 'stop', message: { content: '  useful-name  ' } }))
      .toBe('useful-name')
  })

  it('reports the provider refusal reason to the user', () => {
    const run = () => completionText({
      finish_reason: 'stop',
      message: { content: null, refusal: 'policy category' },
    })
    expect(run).toThrow(UserFacingError)
    expect(run).toThrow('policy category')
  })

  it('rejects content-filtered and token-truncated responses', () => {
    expect(() => completionText({ finish_reason: 'content_filter', message: { content: null } }))
      .toThrow('content filter')
    expect(() => completionText({ finish_reason: 'length', message: { content: 'partial-name' } }))
      .toThrow('cut off')
  })
})

describe('aiRequestFailure', () => {
  it("passes the provider's status and reason through for a bad model", () => {
    const providerError = new OpenAI.NotFoundError(
      404,
      { message: 'The model `gpt-nope` does not exist or you do not have access to it.' },
      undefined,
      new Headers(),
    )
    const failure = aiRequestFailure(providerError)
    expect(failure).toBeInstanceOf(UserFacingError)
    expect(failure.message).toBe(
      'The AI provider returned an error (HTTP 404): The model `gpt-nope` does not exist or you do not have access to it.',
    )
    expect(failure.cause).toBe(providerError)
  })

  it('names the status when the provider sent no reason', () => {
    const failure = aiRequestFailure(new OpenAI.APIError(401, undefined, undefined, new Headers()))
    expect(failure.message).toMatch(/HTTP 401\)\. Check the model and API key/)
  })

  it('tells a timeout apart from an unreachable endpoint', () => {
    expect(aiRequestFailure(new OpenAI.APIConnectionTimeoutError()).message).toMatch(/did not respond in time/)
    expect(aiRequestFailure(new OpenAI.APIConnectionError({ message: 'ECONNREFUSED' })).message)
      .toMatch(/could not be reached/)
  })

  it('leaves any other failure internal', () => {
    const other = new TypeError('/private/tmp/HOSTILE-SENTINEL')
    expect(aiRequestFailure(other)).toBe(other)
    expect(aiRequestFailure(other)).not.toBeInstanceOf(UserFacingError)
  })
})


describe('AI resend policy', () => {
  it('retries only 408, 429, and 503 responses', () => {
    for (const status of [400, 401, 404, 408, 429, 500, 502, 503, 504]) {
      expect(isRetryableAiError(new OpenAI.APIError(status, undefined, undefined, new Headers())))
        .toBe([408, 429, 503].includes(status))
    }
  })
  it('distinguishes a refused or unresolved connection from a dropped request', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE']) {
      const cause = Object.assign(new Error('network failure'), { code })
      expect(isRetryableAiError(new OpenAI.APIConnectionError({ cause })))
        .toBe(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code))
    }
    const cause = new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNREFUSED' }) })
    expect(isRetryableAiError(new OpenAI.APIConnectionError({ cause }))).toBe(true)
    expect(isRetryableAiError(new OpenAI.APIConnectionTimeoutError())).toBe(false)
    expect(isRetryableAiError(new TypeError('internal'))).toBe(false)
  })
  it('honours Retry-After seconds or dates with a 30-second cap', () => {
    const error = (value: string) => new OpenAI.APIError(429, undefined, undefined, new Headers({ 'retry-after': value }))
    expect(aiRetryAfterMs(error('4'))).toBe(4000)
    expect(aiRetryAfterMs(error('90'))).toBe(30_000)
    expect(aiRetryAfterMs(error(new Date(Date.now() + 120_000).toUTCString()))).toBe(30_000)
    expect(aiRetryAfterMs(error('invalid'))).toBeUndefined()
  })
})
