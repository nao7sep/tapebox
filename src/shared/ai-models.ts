// The lineup research document the rows and defaults rest on.
export const MODEL_LINEUP = 'ai-model-lineup-20261004'

export type ModelKind = 'text-frontier' | 'text-smart' | 'text-balanced' | 'text-fast'
export type Provider = 'openai'
export type SupportedModel = {
  provider: Provider
  id: string
  kinds: readonly ModelKind[]
  defaultFor: readonly ModelKind[]
  // The thinking values the model accepts, in the provider's own words: a
  // no-thinking value first, then lowest to highest.
  thinking: readonly string[]
  // The value a role takes for this model, set by the model's own tier.
  defaultThinking: string
}

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: 'openai', id: 'gpt-6-astra', kinds: ['text-frontier'], defaultFor: [], thinking: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinking: 'medium' },
  { provider: 'openai', id: 'gpt-6.1-sol', kinds: ['text-smart'], defaultFor: ['text-smart'], thinking: ['low', 'medium', 'high', 'xhigh', 'max'], defaultThinking: 'medium' },
  { provider: 'openai', id: 'gpt-5.6-terra', kinds: ['text-balanced'], defaultFor: ['text-balanced'], thinking: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultThinking: 'medium' },
  { provider: 'openai', id: 'gpt-6-luna', kinds: ['text-fast'], defaultFor: ['text-fast'], thinking: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultThinking: 'none' },
]

export const AI_ROLES = [
  // A file name from a title; short and formulaic.
  { id: 'slug', kind: 'text-fast' },
] as const

export function modelsFor(provider: Provider, kind: ModelKind): readonly SupportedModel[] {
  return SUPPORTED_MODELS.filter((row) => row.provider === provider && row.kinds.includes(kind))
}

export function defaultModelFor(provider: Provider, kind: ModelKind): string {
  const rows = modelsFor(provider, kind)
  const row = rows.find((model) => model.defaultFor.includes(kind)) ?? rows[0]
  if (!row) throw new Error(`No model for ${provider}/${kind}`)
  return row.id
}

/** The row for a typed id, matched trimmed and case-insensitive; none for an id with no row. */
export function rowFor(provider: Provider, id: string): SupportedModel | undefined {
  const key = id.trim().toLowerCase()
  return SUPPORTED_MODELS.find((row) => row.provider === provider && row.id === key)
}

/** The value a role sends: its chosen value when the row lists it, else the row's default. */
export function thinkingFor(row: SupportedModel, chosen: string): string {
  return row.thinking.includes(chosen) ? chosen : row.defaultThinking
}
