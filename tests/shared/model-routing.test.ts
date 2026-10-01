import { describe, expect, it } from 'vitest'
import { AI_ROLES, SUPPORTED_MODELS, defaultModelFor, modelsFor } from '@shared/ai-models'
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

  it('gives every row its own branch and sends no output ceiling', () => {
    for (const row of SUPPORTED_MODELS) {
      expect(buildSlugRequest(row.id, 'title'), row.id).toEqual({ model: row.id, messages, reasoning_effort: 'medium' })
    }
  })

  it('matches a row on the trimmed, lower-cased id and sends the id as stored', () => {
    expect(buildSlugRequest(' GPT-6-Luna ', 'title')).toEqual({ model: ' GPT-6-Luna ', messages, reasoning_effort: 'medium' })
  })

  it('sends an id with no row the plain request', () => {
    for (const id of ['gpt-future', 'o3-future', 'local-model']) {
      expect(buildSlugRequest(id, 'title')).toEqual({ model: id, messages })
    }
  })
})
