export type ModelKind = 'text-frontier' | 'text-smart' | 'text-balanced' | 'text-fast'
export type Provider = 'openai'
export type SupportedModel = {
  provider: Provider
  id: string
  kinds: readonly ModelKind[]
  defaultFor: readonly ModelKind[]
  // The thinking values the model accepts, in the provider's own words, ascending.
  thinking: readonly string[]
}

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: 'openai', id: 'gpt-6-astra', kinds: ['text-frontier'], defaultFor: [], thinking: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { provider: 'openai', id: 'gpt-6.1-sol', kinds: ['text-smart'], defaultFor: ['text-smart'], thinking: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { provider: 'openai', id: 'gpt-5.6-terra', kinds: ['text-balanced'], defaultFor: ['text-balanced'], thinking: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { provider: 'openai', id: 'gpt-6-luna', kinds: ['text-fast'], defaultFor: ['text-fast'], thinking: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
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

/**
 * A fast role thinks as little as the row allows; every other role thinks
 * adaptively where the row offers it, else at medium, else at its first value.
 */
export function defaultThinkingFor(row: SupportedModel, kind: ModelKind): string {
  if (kind === 'text-fast') return row.thinking.find((value) => value === 'off' || value === 'none') ?? row.thinking[0]!
  return ['adaptive', 'medium'].find((value) => row.thinking.includes(value)) ?? row.thinking[0]!
}

/** The value a role sends: its chosen value when the row lists it, else the role's default for the row. */
export function thinkingFor(row: SupportedModel, kind: ModelKind, chosen: string): string {
  return row.thinking.includes(chosen) ? chosen : defaultThinkingFor(row, kind)
}
