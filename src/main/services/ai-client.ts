import OpenAI from 'openai'
import { getSettings } from '@main/store/config'
import { log } from '@main/io/logger'
import type { AiProfile } from '@shared/settings'
import { readApiKey } from './api-keys'

/**
 * AI operations dispatch.
 *
 * For v1 we only support kind === 'openai-compatible', so the dispatcher is
 * trivial. When Anthropic / Gemini native APIs are added later, switch on
 * profile.kind here.
 */

function activeProfile(): AiProfile {
  const settings = getSettings()
  if (!settings.activeAiProfileId) throw new Error('No active AI profile selected')
  const profile = settings.aiProfiles.find((p) => p.id === settings.activeAiProfileId)
  if (!profile) throw new Error(`Active AI profile not found: ${settings.activeAiProfileId}`)
  return profile
}

export async function generateSlug(opts: {
  title: string | null
  uploader?: string | null
}): Promise<string> {
  const profile = activeProfile()
  const apiKey = await readApiKey(profile.id)
  if (!apiKey) throw new Error(`No API key configured for profile "${profile.name}"`)

  switch (profile.kind) {
    case 'openai-compatible':
      return generateSlugOpenAiCompat(profile, apiKey, opts)
  }
}

async function generateSlugOpenAiCompat(
  profile: AiProfile,
  apiKey: string,
  opts: { title: string | null; uploader?: string | null },
): Promise<string> {
  const client = new OpenAI({ apiKey, baseURL: profile.baseUrl })

  const userPrompt = [
    'Suggest a short kebab-case file slug for this media item.',
    'Output ONLY the slug — lowercase ASCII letters, digits, and hyphens. No quotes, no explanation, no period.',
    'Aim for under 60 characters. Prefer descriptive English keywords drawn from the title.',
    '',
    `Title: ${opts.title ?? '(unknown title)'}`,
    opts.uploader ? `Uploader: ${opts.uploader}` : '',
  ].filter(Boolean).join('\n')

  log.info('ai: generateSlug request', { profile: profile.id, model: profile.model })
  const res = await client.chat.completions.create({
    model: profile.model,
    messages: [
      { role: 'system', content: 'You generate short, descriptive, English file slugs.' },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 60,
  })
  const text = res.choices[0]?.message?.content?.trim() ?? ''
  if (!text) throw new Error('AI returned an empty response')
  return text
}
