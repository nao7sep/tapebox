import OpenAI from 'openai'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { withRetry } from '@main/io/retry'
import { AI_REQUEST_TIMEOUT_MS, HTTP_RETRY } from '@main/io/network'
import { UserFacingError } from '@main/user-facing-error'
import { resolveApiKey } from './api-keys'

/**
 * Slug generation against the single OpenAI-compatible endpoint configured in
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
  const { ai, prompts } = getSettings()
  const apiKey = await resolveApiKey(['openai'])
  if (!apiKey) throw new UserFacingError('refused', 'No AI API key is set. Add one in Settings › AI, then try again.')

  const client = new OpenAI({
    apiKey,
    baseURL: ai.baseUrl,
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

  log.info('ai: generateSlug request', { model: ai.model })
  // Keep the request structurally minimal — just the model and a single user
  // message — so it works across the whole spread of OpenAI-compatible providers
  // and model families. Tuning parameters are the usual portability landmines:
  // newer OpenAI models reject `max_tokens` (demanding `max_completion_tokens`)
  // and some reject a non-default `temperature` outright. Every instruction
  // (length cap, format, what to ignore) already lives in the prompt, so none of
  // those knobs is needed; slugifyAscii + sanitizeFilename bound the result anyway.
  let res: Awaited<ReturnType<typeof client.chat.completions.create>>
  try {
    res = await withRetry(
      HTTP_RETRY,
      () =>
        client.chat.completions.create(
          {
            model: ai.model,
            messages: [{ role: 'user', content: userPrompt }],
          },
          { signal },
        ),
      { signal, isRetryable: isRetryableAiError },
    )
  } catch (err) {
    // A Stop is the user's own choice; it stays a plain abort.
    if (signal.aborted) throw err
    throw aiRequestFailure(err)
  }
  // Result line for the external boundary (the request was logged above): the
  // finish_reason distinguishes a normal stop from a length/content-filter cutoff.
  log.info('ai: generateSlug response', { model: ai.model, finishReason: res.choices[0]?.finish_reason })
  return completionText(res.choices[0])
}

type CompletionChoice = {
  finish_reason: string | null
  message: { refusal?: string | null; content?: unknown }
} | undefined

/** Return only a complete, accepted text result. Provider-declared refusal and
 * truncation reasons are checked before content so partial text is never accepted. */
export function completionText(choice: CompletionChoice): string {
  const message = choice?.message
  // A refusal (or content-filter) comes back as a `refusal` string with null content;
  // surface its reason rather than a generic "empty response".
  if (message?.refusal) {
    throw new UserFacingError('provider', `The AI declined to suggest a name: ${message.refusal}`)
  }
  if (choice?.finish_reason === 'content_filter') {
    throw new UserFacingError('provider', "The AI declined to suggest a name (the provider's content filter stopped it).")
  }
  if (choice?.finish_reason === 'length') {
    throw new UserFacingError('provider', 'The AI response was cut off before it finished. Try again, or shorten the prompt.')
  }
  // Content can be null or a non-string structured part; only a non-empty string is usable.
  const content = message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new UserFacingError('provider', 'The AI returned no usable text. Try again, or check the model in Settings › AI.')
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
    return new UserFacingError('provider', 'The AI provider did not respond in time. Try again later.', { cause: err })
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new UserFacingError(
      'provider',
      'The AI provider could not be reached. Check the base URL in Settings › AI and your connection.',
      { cause: err },
    )
  }
  if (err instanceof OpenAI.APIError && typeof err.status === 'number') {
    const body = err.error as { message?: unknown } | undefined
    const reason = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null
    return new UserFacingError(
      'provider',
      reason
        ? `The AI provider returned an error (HTTP ${err.status}): ${reason}`
        : `The AI provider returned an error (HTTP ${err.status}). Check the model and API key in Settings › AI.`,
      { cause: err },
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Retry transient AI failures only: rate limits (429) and server errors (5xx).
 * A 4xx like 400/401/403 is a config/auth problem that won't fix itself. The
 * SDK's connection, timeout and user-abort errors are APIErrors without a
 * status, so they are not retried: a request that already waited out its
 * deadline is reported rather than repeated.
 */
function isRetryableAiError(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    const status = err.status
    return status === 429 || (typeof status === 'number' && status >= 500)
  }
  return true
}
