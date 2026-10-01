import { describe, expect, it } from 'vitest'
import { AI_ROLES, SUPPORTED_MODELS, defaultModelFor, defaultThinkingFor, modelsFor, rowFor, thinkingFor } from '@shared/ai-models'
import { buildSlugRequest } from '@shared/model-routing'
import { defaultSettings } from '@shared/settings'

const messages = [{ role: 'user', content: 'title' }]

describe('model routing and role guards', () => {
  it('pins every approved row and the slug role', () => {
    expect(SUPPORTED_MODELS.map((row) => row.id)).toEqual([
      'gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-6-luna',
    ])
    expect(AI_ROLES).toEqual([{ id: 'slug', kind: 'text-fast' }])
    expect(defaultModelFor('openai', 'text-fast')).toBe('gpt-6-luna')
  })

  it('has one default for every non-frontier kind and a built-in model for every role', () => {
    for (const kind of new Set(SUPPORTED_MODELS.flatMap((row) => row.kinds))) {
      const rows = modelsFor('openai', kind)
      expect(rows.filter((row) => row.defaultFor.includes(kind))).toHaveLength(kind === 'text-frontier' ? 0 : 1)
    }
    const settings = defaultSettings()
    for (const role of AI_ROLES) {
      expect(modelsFor('openai', role.kind).length).toBeGreaterThan(0)
      expect(settings).toHaveProperty(`openai.${role.id}`)
    }
  })

  it('pins every row\'s thinking values from the research', () => {
    expect(Object.fromEntries(SUPPORTED_MODELS.map((row) => [row.id, row.thinking]))).toEqual({
      'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-5.6-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('gives every row its own branch, translating every thinking value it lists, with no output ceiling', () => {
    for (const row of SUPPORTED_MODELS) {
      for (const value of row.thinking) {
        expect(buildSlugRequest(row.id, value, 'title'), `${row.id} ${value}`).toEqual({ model: row.id, messages, reasoning_effort: value })
      }
    }
  })

  it('matches a row on the trimmed, lower-cased id and sends the id as stored', () => {
    expect(buildSlugRequest(' GPT-6-Luna ', 'low', 'title')).toEqual({ model: ' GPT-6-Luna ', messages, reasoning_effort: 'low' })
    expect(rowFor('openai', ' GPT-6-Luna ')?.id).toBe('gpt-6-luna')
  })

  it('sends an id with no row the plain request and no thinking parameter', () => {
    for (const id of ['gpt-future', 'o3-future', 'local-model']) {
      expect(buildSlugRequest(id, 'high', 'title')).toEqual({ model: id, messages })
      expect(rowFor('openai', id)).toBeUndefined()
    }
  })

  it('defaults thinking by the role\'s tier and replaces an unlisted choice with the default', () => {
    const row = (id: string) => rowFor('openai', id)!
    expect(defaultThinkingFor(row('gpt-6-luna'), 'text-fast')).toBe('none')
    expect(defaultThinkingFor(row('gpt-6.1-sol'), 'text-fast')).toBe('low')
    expect(defaultThinkingFor(row('gpt-5.6-terra'), 'text-balanced')).toBe('medium')
    expect(defaultThinkingFor(row('gpt-6-astra'), 'text-smart')).toBe('medium')
    expect(thinkingFor(row('gpt-6.1-sol'), 'text-fast', 'none')).toBe('low')
    expect(thinkingFor(row('gpt-6.1-sol'), 'text-fast', 'max')).toBe('max')
  })
})
