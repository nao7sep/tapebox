import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AI_ROLES, SUPPORTED_MODELS, defaultModelFor, modelsFor } from '@shared/ai-models'
import { MODEL_FAMILIES, buildSlugRequest, resolveModel } from '@shared/model-routing'
import { defaultSettings } from '@shared/settings'

describe('model routing and role guards', () => {
  it('pins every approved row and the slug role', () => {
    expect(SUPPORTED_MODELS.map((row) => row.id)).toEqual([
      'gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-6-luna',
    ])
    expect(AI_ROLES).toEqual([{ id: 'slug', kind: 'text-fast' }])
    for (const row of SUPPORTED_MODELS) expect(resolveModel(row.id).generic).toBe(false)
    expect(resolveModel('nonsense-model').generic).toBe(true)
    expect(resolveModel('gpt-image-2').generic).toBe(true)
    expect(defaultModelFor('openai', 'text-fast')).toBe('gpt-6-luna')
  })

  it('has one default for every non-frontier kind and a settings field for every role', () => {
    for (const kind of new Set(SUPPORTED_MODELS.flatMap((row) => row.kinds))) {
      const rows = modelsFor('openai', kind)
      expect(rows.filter((row) => row.defaultFor.includes(kind))).toHaveLength(kind === 'text-frontier' ? 0 : 1)
    }
    const settings = defaultSettings()
    const surface = readFileSync('src/renderer/components/SettingsModal.tsx', 'utf8')
    for (const role of AI_ROLES) {
      expect(modelsFor('openai', role.kind).length).toBeGreaterThan(0)
      expect(settings).toHaveProperty(`openai.${role.id}`)
      expect(surface).toContain(`draft['openai.${role.id}']`)
    }
  })

  it('emits only declared family parameters and leaves an unknown id minimal', () => {
    for (const id of [...SUPPORTED_MODELS.map((row) => row.id), 'o3-future', 'gpt-future', 'local-model']) {
      const { model, messages, ...policy } = buildSlugRequest(id, 'title')
      expect(model).toBe(id)
      expect(messages).toEqual([{ role: 'user', content: 'title' }])
      expect(policy).toEqual(resolveModel(id).policy)
      expect(Object.keys(policy)).toEqual(Object.keys(MODEL_FAMILIES[resolveModel(id).id]!.policy))
      expect(policy).not.toHaveProperty('temperature')
    }
    expect(buildSlugRequest('local-model', 'title')).toEqual({
      model: 'local-model', messages: [{ role: 'user', content: 'title' }],
    })
    expect(buildSlugRequest('gpt-future', 'title')).toMatchObject({ max_completion_tokens: 512, reasoning_effort: 'medium' })
  })
})
