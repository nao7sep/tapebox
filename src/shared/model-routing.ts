type ChatPolicy = { max_completion_tokens?: number; reasoning_effort?: 'medium' }
type Family = { id: string; adapter: 'openai.chat'; generic: boolean; policy: ChatPolicy }

export const MODEL_FAMILIES: Record<string, Family> = {
  'openai.chat': {
    id: 'openai.chat', adapter: 'openai.chat', generic: false,
    policy: { max_completion_tokens: 512, reasoning_effort: 'medium' },
  },
  'openai.generic': { id: 'openai.generic', adapter: 'openai.chat', generic: true, policy: {} },
}

// Image ids require an images adapter, which TapeBox does not offer.
export const MODEL_RULES = [
  { pattern: /^gpt-image-/, family: 'openai.generic' },
  { pattern: /^(gpt-|o[0-9])/, family: 'openai.chat' },
] as const
export const MODEL_EXCEPTIONS: Readonly<Record<string, Partial<ChatPolicy>>> = {}

export function resolveModel(id: string): Family {
  const family = MODEL_FAMILIES[MODEL_RULES.find((rule) => rule.pattern.test(id))?.family ?? 'openai.generic']!
  return { ...family, policy: { ...family.policy, ...MODEL_EXCEPTIONS[id] } }
}

export function buildSlugRequest(model: string, content: string) {
  return {
    model,
    messages: [{ role: 'user' as const, content }],
    ...resolveModel(model).policy,
  }
}
