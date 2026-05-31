import OpenAI from 'openai'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import { withRetry } from '@main/io/retry'
import { AI_REQUEST_TIMEOUT_MS, HTTP_RETRY } from '@main/io/network'
import { readAiKey } from './api-keys'

/**
 * Slug generation against the single OpenAI-compatible endpoint configured in
 * Settings. The client is constructed per-call so config edits take effect
 * without restart. withRetry owns the retry schedule (SDK retries disabled to
 * avoid compounding).
 */
export async function generateSlug(opts: {
  title: string | null
  uploader?: string | null
}): Promise<string> {
  const { ai, prompts } = getSettings()
  const apiKey = await readAiKey()
  if (!apiKey) throw new Error('No AI API key configured')

  const client = new OpenAI({
    apiKey,
    baseURL: ai.baseUrl,
    maxRetries: 0,
    timeout: AI_REQUEST_TIMEOUT_MS,
  })

  // The instruction text is user-configurable (Settings → AI); we only fill the
  // {title}/{uploader} tokens. A missing field substitutes to empty — the
  // surrounding tag stays, which the model handles fine.
  const userPrompt = prompts.slug
    .replace(/\{title\}/g, opts.title ?? '')
    .replace(/\{uploader\}/g, opts.uploader ?? '')

  log.info('ai: generateSlug request', { model: ai.model })
  const res = await withRetry(
    HTTP_RETRY,
    () =>
      client.chat.completions.create({
        model: ai.model,
        messages: [
          { role: 'system', content: 'You generate short, descriptive, English file slugs.' },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 60,
      }),
    { isRetryable: isRetryableAiError },
  )
  const text = res.choices[0]?.message?.content?.trim() ?? ''
  if (!text) throw new Error('AI returned an empty response')
  return text
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
