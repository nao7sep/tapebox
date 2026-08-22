import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  defaultSettings,
  SettingsSchema,
  summarizeSettings,
} from '@shared/settings'

// The Settings placeholders render these constants rather than their own copies of
// the strings. This pins the seam: if a fresh config ever stops matching what the
// placeholder promises, the two have drifted and one of them is lying to the user.
describe('the AI defaults have a single source', () => {
  it('seeds a fresh config from the named constants', () => {
    const { ai } = defaultSettings()
    expect(ai.baseUrl).toBe(DEFAULT_AI_BASE_URL)
    expect(ai.model).toBe(DEFAULT_AI_MODEL)
  })

  it('seeds values the schema accepts', () => {
    expect(() => SettingsSchema.parse(defaultSettings())).not.toThrow()
  })
})

describe('the managed-tool gate', () => {
  it('defaults the single launch-check toggle on (nothing auto-downloads)', () => {
    const d = defaultSettings()
    expect(d.checkUpdatesAtLaunch).toBe(true)
    expect(d).not.toHaveProperty('autoDownloadTools')
    expect(d).not.toHaveProperty('checkToolUpdates')
  })

  it('preserves an explicit off value through the schema', () => {
    const parsed = SettingsSchema.parse({ ...defaultSettings(), checkUpdatesAtLaunch: false })
    expect(parsed.checkUpdatesAtLaunch).toBe(false)
  })

  // The per-binary facts moved out of Settings into their own dependencies store;
  // the launch-check TOGGLE stays here (it is a setting the user authors). The
  // legacy-field-stripping behavior now lives in tests/shared/dependencies.test.ts.
  it('no longer carries the binaries facts — those are their own store', () => {
    expect(defaultSettings()).not.toHaveProperty('binaries')
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

  // The schema carries NO field defaults: a config missing a field is rejected
  // (config.ts then self-heals the disposable prefs file to defaults) rather than
  // half-loaded with a guessed value. Guards against silently re-introducing a
  // back-compat default.
  it('is authoritative — rejects a config missing a field rather than defaulting it', () => {
    const raw: Record<string, unknown> = { ...defaultSettings() }
    delete raw['keepAwakeWhilePlaying']

    expect(SettingsSchema.safeParse(raw).success).toBe(false)
  })

  // Volume moved to the layout (state) store — see tests/shared/layout.test.ts.
  // A stray `volume` key on a config is simply ignored, not a field this schema
  // defends: it must not resurrect as config.
  it('does not carry volume — it is view state, not config', () => {
    expect(defaultSettings()).not.toHaveProperty('volume')
    const parsed = SettingsSchema.parse({ ...defaultSettings(), volume: 0.5 } as Record<string, unknown>)
    expect(parsed).not.toHaveProperty('volume')
  })

  // libraryDir defaults to blank ("use the default folder"), exactly like
  // defaultExportDir. main resolves blank → paths.library via getLibraryDir(); the
  // persisted default must never be an absolute path or a cleared field couldn't
  // mean "default".
  it('defaults libraryDir to blank, not an absolute path', () => {
    expect(defaultSettings().libraryDir).toBe('')
  })

  // The UI font is family-only and engine-resolved; blank means "use the built-in
  // default stack" (globals.css @theme --font-sans), exactly like a blank
  // libraryDir/externalPlayer means "use the default".
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
  it('summarizes bounded, non-secret config verbatim', () => {
    const s = defaultSettings()
    s.libraryDir = '/lib'
    s.ai = { baseUrl: 'https://api.example.com/v1', model: 'gpt-x' }
    s.maxConcurrentDownloads = 4
    s.autoplay = false
    s.uiFontFamily = 'Iosevka, monospace'

    expect(summarizeSettings(s)).toMatchObject({
      libraryDir: '/lib',
      aiBaseUrl: 'https://api.example.com/v1',
      aiModel: 'gpt-x',
      maxConcurrentDownloads: 4,
      autoplay: false,
      uiFontFamily: 'Iosevka, monospace',
    })
  })

  it('reduces secret-bearing free-text to presence/count, never its value', () => {
    const s = defaultSettings()
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
    const s = defaultSettings()
    s.ai = { baseUrl: 'https://admin:sk-BASEURL-SECRET@gateway.example/v1', model: 'm' }

    const summary = summarizeSettings(s)
    expect(summary.aiBaseUrl).toBe('https://gateway.example/v1')
    expect(JSON.stringify(summary)).not.toContain('sk-BASEURL-SECRET')
  })

  it('treats blank or whitespace-only ytdlpArgs as unset', () => {
    const s = defaultSettings()
    s.ytdlpArgs = '   '

    expect(summarizeSettings(s).ytdlpArgsSet).toBe(false)
  })

  it('flags whether the slug prompt still equals the in-code default', () => {
    expect(summarizeSettings(defaultSettings()).promptsCustomized).toBe(false)

    const customized = defaultSettings()
    customized.prompts = { slug: 'totally custom prompt' }
    expect(summarizeSettings(customized).promptsCustomized).toBe(true)
  })
})
