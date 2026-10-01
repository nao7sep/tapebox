// One branch per OpenAI row of SUPPORTED_MODELS, matched on the trimmed,
// lower-cased id; the request sends the id as stored. An id with no branch gets
// the plain request, the model and the message, and the provider judges it.
export function buildSlugRequest(model: string, content: string) {
  const request = { model, messages: [{ role: 'user' as const, content }] }
  switch (model.trim().toLowerCase()) {
    // Medium reasoning effort, stated because the provider documents no default.
    case 'gpt-6-astra':
      return { ...request, reasoning_effort: 'medium' as const }
    // Medium reasoning effort, stated rather than left to the provider's default.
    case 'gpt-6.1-sol':
      return { ...request, reasoning_effort: 'medium' as const }
    // Medium reasoning effort, stated rather than left to the provider's default.
    case 'gpt-5.6-terra':
      return { ...request, reasoning_effort: 'medium' as const }
    // Medium reasoning effort, stated rather than left to the provider's default.
    case 'gpt-6-luna':
      return { ...request, reasoning_effort: 'medium' as const }
    default:
      return request
  }
}
