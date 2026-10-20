import { describe, expect, it } from 'vitest'
import { AI_ROLES, SUPPORTED_MODELS, defaultModelFor, modelsFor, rowFor, thinkingFor } from '@shared/ai-models'
import { SLUG_RESPONSE_FORMAT, buildSlugRequest } from '@shared/model-routing'
import { DEFAULT_SLUG_THINKING, defaultSettings } from '@shared/settings'

const messages = [{ role: 'user', content: 'title' }]
const response_format = {
  type: 'json_schema',
  json_schema: {
    name: 'slug',
    strict: true,
    schema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
  },
}

describe('model routing and role guards', () => {

  it('seeds each role with its kind\'s default model and that model\'s default thinking', () => {
    const settings = defaultSettings()
    for (const role of AI_ROLES) {
      const model = defaultModelFor('openai', role.kind)
      expect(settings[`openai.${role.id}`]).toBe(model)
      expect(DEFAULT_SLUG_THINKING).toBe(rowFor('openai', model)!.defaultThinking)
    }
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

  it('gives every row a default thinking value it lists', () => {
    for (const row of SUPPORTED_MODELS) expect(row.thinking, row.id).toContain(row.defaultThinking)
  })

  it('gives every row its own branch, sending every thinking value as chosen, the strict schema, and no output ceiling', () => {
    for (const row of SUPPORTED_MODELS) {
      for (const value of row.thinking) {
        expect(buildSlugRequest(row.id, value, 'title'), `${row.id} ${value}`)
          .toEqual({ model: row.id, messages, response_format, reasoning_effort: value })
      }
    }
    expect(SLUG_RESPONSE_FORMAT).toEqual(response_format)
  })

  it('sends a value that equals the row\'s default rather than omitting it', () => {
    for (const row of SUPPORTED_MODELS) {
      expect(buildSlugRequest(row.id, row.defaultThinking, 'title')).toHaveProperty('reasoning_effort', row.defaultThinking)
    }
  })

  it('matches a row on the trimmed, lower-cased id and sends the id as stored', () => {
    expect(buildSlugRequest(' GPT-6-Luna ', 'low', 'title')).toEqual({ model: ' GPT-6-Luna ', messages, response_format, reasoning_effort: 'low' })
    expect(rowFor('openai', ' GPT-6-Luna ')?.id).toBe('gpt-6-luna')
  })

  it('sends an id with no row the plain request, the strict schema included, and no thinking parameter', () => {
    for (const id of ['gpt-6-sol', 'gpt-5.6-luna', 'gpt-future', 'local-model']) {
      expect(buildSlugRequest(id, 'high', 'title')).toEqual({ model: id, messages, response_format })
      expect(rowFor('openai', id)).toBeUndefined()
    }
  })

  it('replaces a choice the row does not list with the row\'s default', () => {
    const row = (id: string) => rowFor('openai', id)!
    expect(thinkingFor(row('gpt-6.1-sol'), 'none')).toBe('medium')
    expect(thinkingFor(row('gpt-6-astra'), 'none')).toBe('medium')
    expect(thinkingFor(row('gpt-6-luna'), 'adaptive')).toBe('none')
    expect(thinkingFor(row('gpt-6.1-sol'), 'max')).toBe('max')
  })
})
