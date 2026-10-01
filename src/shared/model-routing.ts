import type { ReasoningEffort } from 'openai/resources/shared'

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

// One branch per OpenAI row of SUPPORTED_MODELS, matched on the trimmed,
// lower-cased id; the request sends the id as stored. A branch translates the
// role's thinking value, one its row lists, into the reasoning effort. An id
// with no branch gets the plain request, the model and the message, with no
// thinking parameter, and the provider judges it.
export function buildSlugRequest(model: string, thinking: string | undefined, content: string) {
  const request = { model, messages: [{ role: 'user' as const, content }] }
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
