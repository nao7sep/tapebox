import { describe, expect, it } from 'vitest'
import {
  chromiumLocale,
  effectiveLanguage,
  formattingLocale,
  normalizeLanguagePreference,
  resolveComputerLanguage,
} from '@shared/i18n/languages'

describe('normalizeLanguagePreference', () => {
  it('keeps System and every supported tag', () => {
    expect(normalizeLanguagePreference('system')).toBe('system')
    expect(normalizeLanguagePreference('ja')).toBe('ja')
    expect(normalizeLanguagePreference('zh-Hans')).toBe('zh-Hans')
    expect(normalizeLanguagePreference('pt-BR')).toBe('pt-BR')
  })

  it('follows the computer for anything missing, retired, or hand-edited', () => {
    expect(normalizeLanguagePreference(undefined)).toBe('system')
    expect(normalizeLanguagePreference('zh-hans')).toBe('system')
    expect(normalizeLanguagePreference('pt')).toBe('system')
    expect(normalizeLanguagePreference(3)).toBe('system')
  })
})

describe('resolveComputerLanguage', () => {
  it('takes the first of the computer’s languages that the app ships', () => {
    expect(resolveComputerLanguage(['nl-NL', 'de-DE', 'en-US'])).toBe('de')
    expect(resolveComputerLanguage(['ja-JP'])).toBe('ja')
    expect(resolveComputerLanguage(['ko'])).toBe('ko')
  })

  it('resolves every Chinese, Portuguese and Spanish locale to the one variety shipped', () => {
    expect(resolveComputerLanguage(['zh-TW'])).toBe('zh-Hans')
    expect(resolveComputerLanguage(['zh-Hant-HK'])).toBe('zh-Hans')
    expect(resolveComputerLanguage(['zh-CN'])).toBe('zh-Hans')
    expect(resolveComputerLanguage(['pt-PT'])).toBe('pt-BR')
    expect(resolveComputerLanguage(['es-MX'])).toBe('es')
  })

  it('falls back to English when nothing matches, and skips what cannot be read', () => {
    expect(resolveComputerLanguage(['nl', 'sv'])).toBe('en')
    expect(resolveComputerLanguage([])).toBe('en')
    expect(resolveComputerLanguage(['not a tag', 'fr_CA'])).toBe('fr')
  })
})

describe('effectiveLanguage', () => {
  it('resolves System to the computer’s language and keeps an explicit choice', () => {
    expect(effectiveLanguage('system', 'ko')).toBe('ko')
    expect(effectiveLanguage('fr', 'ko')).toBe('fr')
  })
})

describe('formattingLocale', () => {
  it('uses the computer’s regional locale when it is in the interface language', () => {
    expect(formattingLocale('en', 'en-GB')).toBe('en-GB')
    expect(formattingLocale('pt-BR', 'pt-PT')).toBe('pt-PT')
    expect(formattingLocale('zh-Hans', 'zh-CN')).toBe('zh-CN')
  })

  it('uses the interface language’s own format otherwise', () => {
    expect(formattingLocale('de', 'en-GB')).toBe('de')
    expect(formattingLocale('zh-Hans', 'zh-TW')).toBe('zh-Hans')
    expect(formattingLocale('en', null)).toBe('en')
    expect(formattingLocale('en', 'not a locale')).toBe('en')
  })
})

describe('chromiumLocale', () => {
  it('names the interface language the way Chromium’s --lang switch expects', () => {
    expect(chromiumLocale('zh-Hans')).toBe('zh-CN')
    expect(chromiumLocale('pt-BR')).toBe('pt-BR')
    expect(chromiumLocale('ja')).toBe('ja')
  })
})
