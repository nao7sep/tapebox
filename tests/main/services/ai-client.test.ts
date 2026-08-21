import { describe, expect, it } from 'vitest'
import { completionText } from '@main/services/ai-client'

describe('completionText', () => {
  it('returns a complete accepted response', () => {
    expect(completionText({ finish_reason: 'stop', message: { content: '  useful-name  ' } }))
      .toBe('useful-name')
  })

  it('reports the provider refusal reason', () => {
    expect(() => completionText({
      finish_reason: 'stop',
      message: { content: null, refusal: 'policy category' },
    })).toThrow('policy category')
  })

  it('rejects content-filtered and token-truncated responses', () => {
    expect(() => completionText({ finish_reason: 'content_filter', message: { content: null } }))
      .toThrow('finish_reason: content_filter')
    expect(() => completionText({ finish_reason: 'length', message: { content: 'partial-name' } }))
      .toThrow('finish_reason: length')
  })
})
