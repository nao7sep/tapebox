import OpenAI from 'openai'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { withRetry } from '@main/io/retry'
import { AI_REQUEST_TIMEOUT_MS, HTTP_RETRY } from '@main/io/network'
import { resolveApiKey } from './api-keys'

/**
 * Slug generation against the single OpenAI-compatible endpoint configured in
 * Settings. The client is constructed per-call so config edits take effect
 * without restart. withRetry owns the retry schedule (SDK retries disabled to
 * avoid compounding).
 */
export async function generateSlug(opts: {
  title: string | null
  uploader?: string | null
  description?: string | null
}): Promise<string> {
  const { ai, prompts } = getSettings()
  const apiKey = await resolveApiKey(['openai'])
  if (!apiKey) throw new Error('No AI API key configured')

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
  const res = await withRetry(
    HTTP_RETRY,
    () =>
      client.chat.completions.create({
        model: ai.model,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    { isRetryable: isRetryableAiError },
  )
  // Result line for the external boundary (the request was logged above): the
  // finish_reason distinguishes a normal stop from a length/content-filter cutoff.
  log.info('ai: generateSlug response', { model: ai.model, finishReason: res.choices[0]?.finish_reason })
  const message = res.choices[0]?.message
  // A refusal (or content-filter) comes back as a `refusal` string with null content;
  // surface its reason rather than a generic "empty response".
  if (message?.refusal) {
    throw new Error(`The AI declined to suggest a name: ${message.refusal}`)
  }
  // Content can be null or a non-string structured part; only a non-empty string is usable.
  const content = message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('AI returned no usable text')
  }
  return content.trim()
}

/**
 * Retry transient AI failures only: rate limits (429), server errors (5xx),
 * and connection/timeout errors (no status). A 4xx like 400/401/403 is a
 * config/auth problem that won't fix itself, so don't waste retries on it.
 */
function isRetryableAiError(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    const status = err.status
    return status === 429 || (typeof status === 'number' && status >= 500)
  }
  return true
}
