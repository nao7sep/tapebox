import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { aiRequestFailure, completionText } from '@main/services/ai-client'
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
