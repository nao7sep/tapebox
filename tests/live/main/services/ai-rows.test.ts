// Every supported OpenAI row against the real API: one slug request per row,
// built by the app's own branch at the row's default thinking with the strict
// slug schema, and read by the app's own parser. It proves each request path is
// accepted; the values themselves were settled by the lineup research. Run only
// by npm run test:full, through vitest.live.config.ts.
//
// The cheapest settings: a one-line prompt and a small output ceiling, which the
// app itself never sends; it bounds what a run can spend.

import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'

import { SUPPORTED_MODELS } from '@shared/ai-models'
import { buildSlugRequest } from '@shared/model-routing'

vi.mock('@main/store/config', () => ({ getSettings: () => ({}) }))
vi.mock('@main/services/api-keys', () => ({ resolveApiKey: async () => null }))
vi.mock('@main/io/logger', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('@main/io/records', () => ({ writeRecord: () => {} }))
const { completionSlug } = await import('@main/services/ai-client')

const PROMPT = 'Suggest a short English file slug for the title "Morning walk in the park".'
const OUTPUT_CEILING = 400

function client(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set. The full run calls the real OpenAI API; export OPENAI_API_KEY and run it again.')
  }
  return new OpenAI({ apiKey, maxRetries: 0, timeout: 120_000 })
}

describe('every supported OpenAI row', () => {
  it.each(SUPPORTED_MODELS.map((row) => [row.id, row] as const))('%s accepts the slug request at its default thinking', async (_id, row) => {
    const request = { ...buildSlugRequest(row.id, row.defaultThinking, PROMPT), max_completion_tokens: OUTPUT_CEILING }
    const response = await client().chat.completions.create(request)
    console.log(`${row.id} at ${row.defaultThinking}: ${JSON.stringify(response.usage)}`)
    const slug = completionSlug(response.choices[0])
    expect(slug.length).toBeGreaterThan(0)
  })
})
