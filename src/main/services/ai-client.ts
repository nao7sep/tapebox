import OpenAI from 'openai'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { toJson } from '@main/io/log-format'
import { writeRecord } from '@main/io/records'
import { withRetry } from '@main/io/retry'
import { AI_REQUEST_TIMEOUT_MS, AI_RETRY } from '@main/io/network'
import { UserFacingError } from '@main/user-facing-error'
import { resolveApiKey } from './api-keys'
import { buildSlugRequest } from '@shared/model-routing'
import { describeError } from '@shared/error'
import { AI_ROLES, rowFor, thinkingFor } from '@shared/ai-models'
import { message } from '@shared/i18n/translate'
import { nowUtcIso } from '@shared/utc'

/**
 * Slug generation against the OpenAI endpoint configured in
 * Settings. The client is constructed per-call so config edits take effect
 * without restart. withRetry owns the retry schedule (SDK retries disabled to
 * avoid compounding).
 */
export async function generateSlug(
  opts: {
    tapeId: string
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

  const call: AiCall = { tapeId: opts.tapeId, endpoint: settings['openai.endpoint'], model, sent: null }
  const client = new OpenAI({
    apiKey,
    baseURL: settings['openai.endpoint'],
    maxRetries: 0,
    timeout: AI_REQUEST_TIMEOUT_MS,
    fetch: (input, init) => {
      call.sent = sentRequest(input, init)
      return fetch(input, init)
    },
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

  const request = buildSlugRequest(model, thinking, userPrompt)
  log.info('ai: generateSlug request', { tapeId: opts.tapeId, model, thinking })
  let res: Awaited<ReturnType<typeof client.chat.completions.create>>
  try {
    res = await withRetry(
      AI_RETRY,
      () => recordedAttempt(call, () => client.chat.completions.create(request, { signal })),
      { signal, isRetryable: isRetryableAiError, retryAfterMs: aiRetryAfterMs },
    )
  } catch (err) {
    // A Stop is the user's own choice; it stays a plain abort.
    if (signal.aborted) throw err
    throw aiRequestFailure(err)
  }
  // Result line for the external boundary (the request was logged above): the
  // finish_reason distinguishes a normal stop from a length/content-filter cutoff.
  log.info('ai: generateSlug response', { tapeId: opts.tapeId, model, finishReason: res.choices[0]?.finish_reason })
  return completionText(res.choices[0])
}

type SentRequest = { method: string; url: string; headers: Record<string, string>; body: unknown }
type AiCall = { tapeId: string; endpoint: string; model: string; sent: SentRequest | null }

/** The request as it goes to `fetch`: method, URL, every header and the body. */
function sentRequest(input: string | URL | Request, init: RequestInit | undefined): SentRequest {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const body = typeof init?.body === 'string' ? parsedBody(init.body) : init?.body ?? null
  return {
    method: init?.method ?? 'GET',
    url,
    headers: Object.fromEntries(new Headers(init?.headers)),
    body,
  }
}

function parsedBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Send one attempt and record it whole, the request as sent and the response,
 * as an `ai_calls` row (data-lifecycle conventions). A provider that answered
 * with an error has its status and body recorded as the response; an attempt
 * that ended before anything was sent has no request.
 */
async function recordedAttempt<T extends object>(call: AiCall, send: () => Promise<T>): Promise<T> {
  call.sent = null
  const startedAtUtc = nowUtcIso()
  try {
    const response = await send()
    recordAiCall(call, startedAtUtc, null, response, null)
    return response
  } catch (err) {
    const answered = err instanceof OpenAI.APIError ? err : null
    recordAiCall(call, startedAtUtc, answered?.status ?? null, answered?.error ?? null, err)
    throw err
  }
}

function recordAiCall(
  call: AiCall,
  startedAtUtc: string,
  status: number | null,
  response: object | null,
  error: unknown,
): void {
  const row = {
    tape_id: call.tapeId,
    started_at_utc: startedAtUtc,
    ended_at_utc: nowUtcIso(),
    endpoint: call.endpoint,
    model: call.model,
    request: call.sent === null ? null : toJson(call.sent),
    status,
    response: response === null ? null : toJson(response),
    error: error === null ? null : toJson(describeError(error)),
  }
  writeRecord('ai_calls', row, () => toJson({ record: 'ai call', ...row }))
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
