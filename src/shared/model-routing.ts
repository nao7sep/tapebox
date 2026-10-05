import type { ReasoningEffort, ResponseFormatJSONSchema } from 'openai/resources/shared'

// The OpenAI reasoning efforts in the provider's own words, which are also the
// thinking values the rows list.
const REASONING_EFFORTS: Record<string, ReasoningEffort> = {
  none: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

// The slug comes back in a strict schema, one field holding the slug, so it
// cannot arrive in another shape. It is part of the feature, so every request
// carries it, the plain one included.
export const SLUG_RESPONSE_FORMAT: ResponseFormatJSONSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'slug',
    strict: true,
    schema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
}

// One branch per OpenAI row of SUPPORTED_MODELS, matched on the trimmed,
// lower-cased id; the request sends the id as stored. A branch translates the
// role's thinking value, one its row lists, into the reasoning effort. An id
// with no branch gets the plain request, the model, the message and the response
// format, with no thinking parameter, and the provider judges it.
export function buildSlugRequest(model: string, thinking: string | undefined, content: string) {
  const request = { model, messages: [{ role: 'user' as const, content }], response_format: SLUG_RESPONSE_FORMAT }
  const effort = thinking === undefined ? {} : { reasoning_effort: REASONING_EFFORTS[thinking] }
  switch (model.trim().toLowerCase()) {
    // Reasoning effort from low to max; this model cannot turn reasoning off.
    case 'gpt-6-astra':
      return { ...request, ...effort }
    // Reasoning effort from low to max; this model cannot turn reasoning off.
    case 'gpt-6.1-sol':
      return { ...request, ...effort }
    // Reasoning effort from none, which turns reasoning off, to max.
    case 'gpt-5.6-terra':
      return { ...request, ...effort }
    // Reasoning effort from none, which turns reasoning off, to max.
    case 'gpt-6-luna':
      return { ...request, ...effort }
    default:
      return request
  }
}
