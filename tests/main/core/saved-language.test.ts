import { describe, expect, it } from 'vitest'
import { readSavedLanguagePreference } from '@main/core/saved-language'
import { header } from '../../helpers/file-header'

describe('readSavedLanguagePreference', () => {
  it('reads the saved choice from the settings file’s text', () => {
    expect(readSavedLanguagePreference(JSON.stringify({ ...header('config'), language: 'ja', theme: 'dark' }))).toBe('ja')
    expect(readSavedLanguagePreference(JSON.stringify({ ...header('config'), language: 'system' }))).toBe('system')
  })

  it('follows the computer when the file is missing, unreadable, or holds no known language', () => {
    expect(readSavedLanguagePreference(null)).toBe('system')
    expect(readSavedLanguagePreference('{ not json')).toBe('system')
    expect(readSavedLanguagePreference('null')).toBe('system')
    expect(readSavedLanguagePreference(JSON.stringify({ ...header('config'), language: 'nl' }))).toBe('system')
    expect(readSavedLanguagePreference(JSON.stringify({ formatVersion: 'one', language: 'ja' })), 'a malformed marker is unreadable').toBe('system')
    expect(readSavedLanguagePreference(JSON.stringify({ language: 'ja' })), 'no marker is unreadable').toBe('system')
    expect(readSavedLanguagePreference(JSON.stringify({}))).toBe('system')
  })
})
