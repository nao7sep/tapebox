import { describe, expect, it } from 'vitest'
import { readSavedLanguagePreference } from '@main/core/saved-language'

describe('readSavedLanguagePreference', () => {
  it('reads the saved choice from the settings file’s text', () => {
    expect(readSavedLanguagePreference(JSON.stringify({ language: 'ja', theme: 'dark' }))).toBe('ja')
    expect(readSavedLanguagePreference(JSON.stringify({ language: 'system' }))).toBe('system')
  })

  it('follows the computer when the file is missing, unreadable, or holds no known language', () => {
    expect(readSavedLanguagePreference(null)).toBe('system')
    expect(readSavedLanguagePreference('{ not json')).toBe('system')
    expect(readSavedLanguagePreference('null')).toBe('system')
    expect(readSavedLanguagePreference(JSON.stringify({ language: 'nl' }))).toBe('system')
    expect(readSavedLanguagePreference(JSON.stringify({}))).toBe('system')
  })
})
