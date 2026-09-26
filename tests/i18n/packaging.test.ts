import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LANGUAGES } from '@shared/i18n/languages'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

describe('packaged localizations', () => {
  // AppKit draws its own menu items in a language the bundle declares.
  it('declares exactly the interface languages in the macOS bundle', () => {
    expect(packageJson.build.mac.extendInfo.CFBundleLocalizations).toEqual([...LANGUAGES])
  })

  // Only the interface languages' Electron locales ship, with en-US kept as
  // Chromium's fallback, so System resolves AppKit to the interface's language.
  it('keeps each interface language’s Electron locale, on macOS and Windows', () => {
    expect(packageJson.build.electronLanguages).toEqual([
      'en', 'en-US', 'de', 'es', 'fr', 'it', 'pt_BR', 'pt-BR', 'ru', 'ja', 'ko', 'zh_CN', 'zh-CN',
    ])
  })

  // The installer follows the computer's language within the set, English first
  // as the fallback.
  it('speaks the interface languages in the Windows installer', () => {
    expect(packageJson.build.nsis.multiLanguageInstaller).toBe(true)
    expect(packageJson.build.nsis.installerLanguages).toEqual([
      'en_US', 'de_DE', 'es_ES', 'fr_FR', 'it_IT', 'pt_BR', 'ru_RU', 'ja_JP', 'ko_KR', 'zh_CN',
    ])
  })
})
