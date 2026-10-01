import OpenAI from 'openai'
import { paths } from '@main/paths'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { ModelListsSchema, type ModelLists } from '@shared/model-lists'
import { resolveModel } from '@shared/model-routing'
import { nowUtcIso } from '@shared/utc'
import { resolveApiKey } from './api-keys'

const DAY_MS = 86_400_000
let attemptedAt = 0
let pending: Promise<string[]> | null = null
let warnedRead = false

/** Settings owns this optional refresh; startup and slug generation never call it. */
export function modelList(
  options: { endpoint: string; force: boolean; apiKey?: string },
  signal: AbortSignal,
): Promise<string[]> {
  if (pending) return pending
  pending = loadAndRefresh(options, signal).finally(() => { pending = null })
  return pending
}

async function loadAndRefresh(
  options: { endpoint: string; force: boolean; apiKey?: string },
  parentSignal: AbortSignal,
): Promise<string[]> {
  let facts: ModelLists = {}
  try {
    facts = await readJsonOptional(paths.modelLists, ModelListsSchema) ?? {}
  } catch (error) {
    if (!warnedRead) log.warn('model lists unreadable; using bundled suggestions', { error: describeError(error) })
    warnedRead = true
  }
  const saved = facts.openai
  const last = Math.max(attemptedAt, saved ? Date.parse(saved.fetchedAtUtc) : 0)
  if (!options.force && Date.now() - last < DAY_MS) return saved?.ids ?? []
  const apiKey = options.apiKey || await resolveApiKey('openai')
  if (!apiKey) return saved?.ids ?? []
  attemptedAt = Date.now()
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)])
  try {
    const client = new OpenAI({ apiKey, baseURL: options.endpoint, maxRetries: 0, timeout: 30_000 })
    const response = await client.models.list({ signal })
    const ids = [...new Set(response.data.map((row) => row.id).filter((id) => !resolveModel(id).generic))]
    signal.throwIfAborted()
    facts.openai = { fetchedAtUtc: nowUtcIso(), ids }
    // Re-derivable provider facts are not settings or backup history.
    await writeJsonAtomic(paths.modelLists, facts, ModelListsSchema)
    return ids
  } catch (error) {
    if (!parentSignal.aborted) log.warn('model list refresh failed; keeping existing suggestions', { error: describeError(error) })
    return saved?.ids ?? []
  }
}
