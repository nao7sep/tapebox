import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENAI_ENDPOINT,
  DEFAULT_AI_MODEL,
  cleanSettingsSets,
  defaultSettings,
  SettingsSchema,
  summarizeSettings,
} from '@shared/settings'

// The built-in settings use these constants, which Reset model also fills in,
// rather than their own copies of the strings.
describe('the AI defaults have a single source', () => {
  it('uses built-in values from the named constants', () => {
    const s = defaultSettings()
    expect(s['openai.endpoint']).toBe(DEFAULT_OPENAI_ENDPOINT)
    expect(s['openai.slug']).toBe(DEFAULT_AI_MODEL)
  })

  it('provides values the schema accepts', () => {
    expect(() => SettingsSchema.parse(defaultSettings())).not.toThrow()
  })

  it('keeps every built-in text in its cleaned form', () => {
    expect(cleanSettingsSets(defaultSettings())).toEqual(defaultSettings())
  })
})

describe('the managed-tool gate', () => {
  it('defaults the single launch-check toggle on (nothing auto-downloads)', () => {
    const d = defaultSettings()
    expect(d.checkUpdatesAtLaunch).toBe(true)
  })

  it('preserves an explicit off value through the schema', () => {
    const parsed = SettingsSchema.parse({ ...defaultSettings(), checkUpdatesAtLaunch: false })
    expect(parsed.checkUpdatesAtLaunch).toBe(false)
  })

})

describe('SettingsSchema', () => {
  it('parses a complete config', () => {
    const raw = defaultSettings()

    expect(SettingsSchema.parse(raw).autoplay).toBe(true)
  })

  it('preserves an explicit value rather than overriding it', () => {
    const raw = { ...defaultSettings(), autoplay: false }

    expect(SettingsSchema.parse(raw).autoplay).toBe(false)
  })

  it('accepts absent sets without materializing their built-ins', () => {
    expect(SettingsSchema.parse({})).toEqual({})
    expect(SettingsSchema.parse({ autoplay: false })).toEqual({ autoplay: false })
  })

  // A key the schema does not define, such as view state that belongs to the
  // layout store, is dropped rather than kept as config.
  it('drops a key it does not define', () => {
    const parsed = SettingsSchema.parse({ ...defaultSettings(), leftPaneWidth: 300 } as Record<string, unknown>)
    expect(parsed).not.toHaveProperty('leftPaneWidth')
  })

  // collectionDir defaults to blank ("use the default folder"), exactly like
  // defaultExportDir. main resolves blank → paths.collection via getCollectionDir(); the
  // persisted default must never be an absolute path or a cleared field couldn't
  // mean "default".
  it('defaults collectionDir to blank, not an absolute path', () => {
    expect(defaultSettings().collectionDir).toBe('')
  })

  // The UI font is family-only and engine-resolved; blank means "use the built-in
  // default stack" (globals.css @theme --font-sans), exactly like a blank
  // collectionDir/externalPlayer means "use the default".
  it('defaults uiFontFamily to blank, meaning the built-in default font', () => {
    expect(defaultSettings().uiFontFamily).toBe('')
  })

  it('rejects invalid or duplicate durable site-profile identities', () => {
    const profile = { id: 'Ab12_-xy', name: 'a', urlPattern: 'x', isRegex: false, args: '', comment: '' }
    expect(SettingsSchema.safeParse({ ...defaultSettings(), siteProfiles: [{ ...profile, id: '' }] }).success).toBe(false)
    expect(SettingsSchema.safeParse({ ...defaultSettings(), siteProfiles: [profile, { ...profile }] }).success).toBe(false)
  })
})

describe('summarizeSettings', () => {
  it('logs each setting as it is', () => {
    const s = defaultSettings()
    s.collectionDir = '/lib'
    s['openai.endpoint'] = 'https://api.example.com/v1'
    s['openai.slug'] = 'gpt-x'
    s.maxConcurrentDownloads = 4
    s.autoplay = false
    s.uiFontFamily = 'Iosevka, monospace'

    expect(summarizeSettings(s)).toMatchObject({
      collectionDir: '/lib',
      aiEndpoint: 'https://api.example.com/v1',
      aiModel: 'gpt-x',
      maxConcurrentDownloads: 4,
      autoplay: false,
      uiFontFamily: 'Iosevka, monospace',
    })
  })

  it('logs free text, profiles and a credential-bearing endpoint as they are', () => {
    const s = defaultSettings()
    s['openai.endpoint'] = 'https://admin:sk-ENDPOINT@gateway.example/v1'
    s.ytdlpArgs = '--add-header "Authorization: Bearer YTDLP_TOKEN"'
    s.siteProfiles = [
      { id: '1', name: 'a', urlPattern: 'x', isRegex: false, args: '--cookies PROFILE_COOKIES', comment: '' },
    ]
    s.prompts = { slug: 'custom prompt' }

    expect(summarizeSettings(s)).toMatchObject({
      aiEndpoint: 'https://admin:sk-ENDPOINT@gateway.example/v1',
      ytdlpArgs: '--add-header "Authorization: Bearer YTDLP_TOKEN"',
      siteProfiles: s.siteProfiles,
      slugPrompt: 'custom prompt',
    })
  })
})

describe('the theme setting', () => {
  it('defaults to System and keeps each saved choice', () => {
    expect(defaultSettings().theme).toBe('system')
    for (const theme of ['system', 'light', 'dark'] as const) {
      expect(SettingsSchema.parse({ ...defaultSettings(), theme }).theme).toBe(theme)
    }
  })

  it('leaves a missing theme absent and rejects malformed copies', () => {
    expect(SettingsSchema.parse({})).not.toHaveProperty('theme')
    expect(SettingsSchema.safeParse({ theme: 'sepia' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ theme: 42 }).success).toBe(false)
  })

  it('appears in the startup settings summary', () => {
    expect(summarizeSettings({ ...defaultSettings(), theme: 'dark' }).theme).toBe('dark')
  })
})


describe('site profile regular expressions', () => {
  const profile = { id: 'profile1', name: 'Example', urlPattern: '[', isRegex: true, args: '', comment: '' }

  it('rejects an invalid regular expression at the URL pattern field', () => {
    const result = SettingsSchema.safeParse({ siteProfiles: [profile] })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['siteProfiles', 0, 'urlPattern'])
  })

  it('allows ordinary substring patterns containing regex syntax', () => {
    expect(SettingsSchema.safeParse({ siteProfiles: [{ ...profile, isRegex: false }] }).success).toBe(true)
    expect(SettingsSchema.safeParse({ siteProfiles: [{ ...profile, urlPattern: '^https://example\\.com/' }] }).success).toBe(true)
  })
})
