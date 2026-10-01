export type ModelKind = 'text-frontier' | 'text-smart' | 'text-balanced' | 'text-fast'
export type Provider = 'openai'
export type SupportedModel = {
  provider: Provider
  id: string
  kinds: readonly ModelKind[]
  defaultFor: readonly ModelKind[]
}

export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  { provider: 'openai', id: 'gpt-6-astra', kinds: ['text-frontier'], defaultFor: [] },
  { provider: 'openai', id: 'gpt-6.1-sol', kinds: ['text-smart'], defaultFor: ['text-smart'] },
  { provider: 'openai', id: 'gpt-5.6-terra', kinds: ['text-balanced'], defaultFor: ['text-balanced'] },
  { provider: 'openai', id: 'gpt-6-luna', kinds: ['text-fast'], defaultFor: ['text-fast'] },
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
