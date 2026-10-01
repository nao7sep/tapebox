import OpenAI from 'openai'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { withRetry } from '@main/io/retry'
import { AI_REQUEST_TIMEOUT_MS, AI_RETRY } from '@main/io/network'
import { UserFacingError } from '@main/user-facing-error'
import { resolveApiKey } from './api-keys'
import { buildSlugRequest } from '@shared/model-routing'
import { AI_ROLES, rowFor, thinkingFor } from '@shared/ai-models'
import { message } from '@shared/i18n/translate'

/**
 * Slug generation against the OpenAI endpoint configured in
 * Settings. The client is constructed per-call so config edits take effect
 * without restart. withRetry owns the retry schedule (SDK retries disabled to
 * avoid compounding).
 */
export async function generateSlug(
  opts: {
    title: string | null
    uploader?: string | null
    description?: string | null
  },
  signal: AbortSignal,
): Promise<string> {
  const settings = getSettings()
  const { prompts } = settings
  const model = settings['openai.slug']
  // A model with no row gets no thinking parameter; a listed model gets the
  // role's chosen value, or its default when the model does not list it.
  const row = rowFor('openai', model)
  const thinking = row ? thinkingFor(row, AI_ROLES[0].kind, settings['openai.thinking.slug']) : undefined
  const apiKey = await resolveApiKey('openai')
  if (!apiKey) throw new UserFacingError('refused', message('errors.aiNoKey'))

  const client = new OpenAI({
    apiKey,
    baseURL: settings['openai.endpoint'],
    maxRetries: 0,
    timeout: AI_REQUEST_TIMEOUT_MS,
  })

  // The instruction text is user-configurable (Settings → AI); we only fill the
  // {title}/{uploader}/{description} tokens. A missing field substitutes to
  // empty — the surrounding tag stays, which the model handles fine. The whole
  // description is sent as-is when the user's prompt references it; trusting the
  // user's choice to include it (and to instruct the model how to treat it).
  const userPrompt = prompts.slug
    .replace(/\{title\}/g, opts.title ?? '')
    .replace(/\{uploader\}/g, opts.uploader ?? '')
    .replace(/\{description\}/g, opts.description ?? '')

  log.info('ai: generateSlug request', { model, thinking })
  let res: Awaited<ReturnType<typeof client.chat.completions.create>>
  try {
    res = await withRetry(
      AI_RETRY,
      () =>
        client.chat.completions.create(
          buildSlugRequest(model, thinking, userPrompt),
          { signal },
        ),
      { signal, isRetryable: isRetryableAiError, retryAfterMs: aiRetryAfterMs },
    )
  } catch (err) {
    // A Stop is the user's own choice; it stays a plain abort.
    if (signal.aborted) throw err
    throw aiRequestFailure(err)
  }
  // Result line for the external boundary (the request was logged above): the
  // finish_reason distinguishes a normal stop from a length/content-filter cutoff.
  log.info('ai: generateSlug response', { model, finishReason: res.choices[0]?.finish_reason })
  return completionText(res.choices[0])
}

type CompletionChoice = {
  finish_reason: string | null
  message: { refusal?: string | null; content?: unknown }
} | undefined

/** Return only a complete, accepted text result. Provider-declared refusal and
 * truncation reasons are checked before content so partial text is never accepted. */
export function completionText(choice: CompletionChoice): string {
  const choiceMessage = choice?.message
  // A refusal (or content-filter) comes back as a `refusal` string with null content;
  // surface its reason rather than a generic "empty response".
  if (choiceMessage?.refusal) {
    throw new UserFacingError('provider', message('errors.aiRefused', { reason: choiceMessage.refusal }))
  }
  if (choice?.finish_reason === 'content_filter') {
    throw new UserFacingError('provider', message('errors.aiContentFilter'))
  }
  if (choice?.finish_reason === 'length') {
    throw new UserFacingError('provider', message('errors.aiCutOff'))
  }
  // Content can be null or a non-string structured part; only a non-empty string is usable.
  const content = choiceMessage?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new UserFacingError('provider', message('errors.aiNoText'))
  }
  return content.trim()
}

/**
 * The user-facing form of a failed request: the provider's own status and reason
 * when it answered (a wrong model name, a key without access, a bad request), or
 * what kept it from answering. The provider's reason is what tells the user what to
 * fix (ai-model-routing-conventions, fail fast), so it is passed through as sent.
 * The original error stays as the cause for the log.
 */
export function aiRequestFailure(err: unknown): Error {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new UserFacingError('provider', message('errors.aiTimeout'), { cause: err })
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new UserFacingError(
      'provider',
      message('errors.aiUnreachable'),
      { cause: err },
    )
  }
  if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
    const body = err.error as { message?: unknown } | undefined
    const reason = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null
    return new UserFacingError(
      'provider',
      reason
        ? message('errors.aiHttpReason', { status: String(err.status), reason })
        : message('errors.aiHttp', { status: String(err.status) }),
      { cause: err },
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

/** A waiting user resends only known transient refusals, never unknown outcomes. */
export function isRetryableAiError(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return false
  if (err instanceof OpenAI.APIConnectionError) {
    // Node fetch wraps socket errors in a TypeError; the SDK preserves that cause.
    const cause = err.cause as (NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }) | undefined
    const code = cause?.code ?? cause?.cause?.code
    return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
  }
  return err instanceof OpenAI.APIError && [408, 429, 503].includes(err.status ?? 0)
}

export function aiRetryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof OpenAI.APIError)) return undefined
  const value = err.headers?.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(ms) ? Math.max(0, Math.min(30_000, ms)) : undefined
}
