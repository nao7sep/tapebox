import { describe, expect, it } from 'vitest'
import { defaultSettings, SettingsSchema, summarizeSettings } from '@shared/settings'

describe('SettingsSchema', () => {
  it('defaults autoplay for configs that do not have the field yet', () => {
    const raw = settingsWithoutAutoplay()

    expect(SettingsSchema.parse(raw).autoplay).toBe(true)
  })

  it('preserves an explicit autoplay-off value', () => {
    const raw = { ...settingsWithoutAutoplay(), autoplay: false }

    expect(SettingsSchema.parse(raw).autoplay).toBe(false)
  })
})

describe('summarizeSettings', () => {
  it('summarizes bounded, non-secret config verbatim', () => {
    const s = defaultSettings('/lib')
    s.ai = { baseUrl: 'https://api.example.com/v1', model: 'gpt-x' }
    s.maxConcurrentDownloads = 4
    s.autoplay = false

    expect(summarizeSettings(s)).toMatchObject({
      libraryDir: '/lib',
      aiBaseUrl: 'https://api.example.com/v1',
      aiModel: 'gpt-x',
      maxConcurrentDownloads: 4,
      autoplay: false,
    })
  })

  it('reduces secret-bearing free-text to presence/count, never its value', () => {
    const s = defaultSettings('/lib')
    s.ytdlpArgs = '--add-header "Authorization: Bearer YTDLP_SECRET"'
    s.siteProfiles = [
      { id: '1', name: 'a', urlPattern: 'x', isRegex: false, args: '--cookies PROFILE_SECRET', comment: '' },
      { id: '2', name: 'b', urlPattern: 'y', isRegex: false, args: '', comment: '' },
    ]

    const summary = summarizeSettings(s)
    expect(summary).toMatchObject({ ytdlpArgsSet: true, siteProfileCount: 2 })

    // Name-based redaction cannot catch a secret living inside a CLI string, so
    // the raw args must never be emitted — assert neither secret survives anywhere
    // in the serialized summary.
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('YTDLP_SECRET')
    expect(serialized).not.toContain('PROFILE_SECRET')
  })

  it('strips credentials from the AI baseUrl before logging it', () => {
    const s = defaultSettings('/lib')
    s.ai = { baseUrl: 'https://admin:sk-BASEURL-SECRET@gateway.example/v1', model: 'm' }

    const summary = summarizeSettings(s)
    expect(summary.aiBaseUrl).toBe('https://gateway.example/v1')
    expect(JSON.stringify(summary)).not.toContain('sk-BASEURL-SECRET')
  })

  it('treats blank or whitespace-only ytdlpArgs as unset', () => {
    const s = defaultSettings('/lib')
    s.ytdlpArgs = '   '

    expect(summarizeSettings(s).ytdlpArgsSet).toBe(false)
  })

  it('flags whether the slug prompt still equals the in-code default', () => {
    expect(summarizeSettings(defaultSettings('/lib')).promptsCustomized).toBe(false)

    const customized = defaultSettings('/lib')
    customized.prompts = { slug: 'totally custom prompt' }
    expect(summarizeSettings(customized).promptsCustomized).toBe(true)
  })
})

function settingsWithoutAutoplay(): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...defaultSettings('/tmp/tapebox-library') }
  delete raw['autoplay']
  return raw
}
