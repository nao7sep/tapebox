import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chromiumLocale, LANGUAGES, type Language } from '@shared/i18n/languages'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

describe('packaged localizations', () => {
  // AppKit draws its own menu items in a language the bundle declares.
  it('declares exactly the interface languages in the macOS bundle', () => {
    expect(packageJson.build.mac.extendInfo.CFBundleLocalizations).toEqual([...LANGUAGES])
  })

  // Only the interface languages' Electron locales ship, with en-US kept as
  // Chromium's fallback, so System resolves AppKit to the interface's language.
  // macOS names a regional locale's folder with an underscore, Windows with a hyphen.
  it('keeps each interface language’s Electron locale, on macOS and Windows', () => {
    const expected = LANGUAGES.flatMap((language) => {
      if (language === 'en') return ['en', 'en-US']
      const locale = chromiumLocale(language)
      return locale.includes('-') ? [locale.replace('-', '_'), locale] : [locale]
    })
    expect(packageJson.build.electronLanguages).toEqual(expected)
  })

  // The installer follows the computer's language within the set, English first
  // as the fallback.
  it('speaks the interface languages in the Windows installer', () => {
    // NSIS's language for each interface language; the record type makes a new
    // interface language need one.
    const nsis: Record<Language, string> = {
      en: 'en_US', de: 'de_DE', es: 'es_ES', fr: 'fr_FR', it: 'it_IT',
      'pt-BR': 'pt_BR', ru: 'ru_RU', ja: 'ja_JP', ko: 'ko_KR', 'zh-Hans': 'zh_CN',
    }
    expect(packageJson.build.nsis.multiLanguageInstaller).toBe(true)
    expect(packageJson.build.nsis.installerLanguages).toEqual(LANGUAGES.map((language) => nsis[language]))
  })
})
