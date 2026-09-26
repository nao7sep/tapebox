import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const defaults = new Map<string, unknown>()
  const calls: string[] = []
  return {
    defaults,
    calls,
    preferred: ['ja-JP', 'en-US'],
    configText: null as string | null,
    switches: [] as Array<[string, string]>,
    menus: [] as unknown[],
    isPackaged: true,
  }
})

vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: (name: string, value: string) => electron.switches.push([name, value]) },
    // What the computer prefers, unless this app's own AppleLanguages shadows it.
    getPreferredSystemLanguages: () => {
      electron.calls.push('read')
      const own = electron.defaults.get('AppleLanguages') as string[] | undefined
      return own ?? electron.preferred
    },
    getSystemLocale: () => 'ja-JP',
    get isPackaged() {
      return electron.isPackaged
    },
  },
  ipcMain: { on: vi.fn() },
  systemPreferences: {
    setUserDefault: (key: string, _type: string, value: unknown) => {
      electron.calls.push(`set ${JSON.stringify(value)}`)
      electron.defaults.set(key, value)
    },
    removeUserDefault: (key: string) => {
      electron.calls.push('remove')
      electron.defaults.delete(key)
    },
  },
}))
vi.mock('node:fs', () => ({
  readFileSync: () => {
    if (electron.configText === null) throw new Error('ENOENT')
    return electron.configText
  },
}))
vi.mock('@main/menu', () => ({ installApplicationMenu: (t: unknown) => electron.menus.push(t) }))
vi.mock('@main/paths', () => ({ paths: { config: '/tmp/tapebox-test/config.json' } }))

import type { Translator } from '@shared/i18n/translate'

async function load() {
  vi.resetModules()
  return import('@main/i18n')
}

const originalPlatform = process.platform
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

beforeEach(() => {
  electron.defaults.clear()
  electron.calls.splice(0)
  electron.switches.splice(0)
  electron.menus.splice(0)
  electron.preferred = ['ja-JP', 'en-US']
  electron.configText = null
  electron.isPackaged = true
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

describe('main-process interface language', () => {
  it('follows the computer for System, with nothing recorded for AppKit or Chromium', async () => {
    const i18n = await load()
    i18n.settleLanguageBeforeReady()
    i18n.settleLanguageWhenReady()
    expect(i18n.currentLanguage()).toBe('ja')
    expect(electron.switches).toEqual([])
    expect(electron.defaults.has('AppleLanguages')).toBe(false)
    expect((electron.menus.at(-1) as Translator).language).toBe('ja')
  })

  it('speaks a saved choice at once and records it for AppKit’s next launch', async () => {
    electron.configText = JSON.stringify({ language: 'de' })
    const i18n = await load()
    i18n.settleLanguageBeforeReady()
    i18n.settleLanguageWhenReady()
    expect(i18n.currentLanguage()).toBe('de')
    expect(electron.switches).toEqual([['lang', 'de']])
    expect(electron.defaults.get('AppleLanguages')).toEqual(['de'])
    expect(i18n.languageEnvironment()).toEqual({ preference: 'de', systemLanguage: 'ja', systemLocale: 'ja-JP' })
  })

  it('reads the computer’s own languages, not the entry it recorded last time', async () => {
    electron.defaults.set('AppleLanguages', ['fr'])
    const i18n = await load()
    i18n.settleLanguageBeforeReady()
    i18n.settleLanguageWhenReady()
    expect(electron.calls.indexOf('remove')).toBeLessThan(electron.calls.indexOf('read'))
    expect(i18n.languageEnvironment().systemLanguage).toBe('ja')
  })

  it('follows a choice saved in Settings, and clears the record when System is chosen again', async () => {
    const i18n = await load()
    i18n.settleLanguageBeforeReady()
    i18n.settleLanguageWhenReady()
    i18n.applyLanguagePreference('ko')
    expect(i18n.currentLanguage()).toBe('ko')
    expect(electron.defaults.get('AppleLanguages')).toEqual(['ko'])
    expect((electron.menus.at(-1) as Translator).language).toBe('ko')
    i18n.applyLanguagePreference('system')
    expect(i18n.currentLanguage()).toBe('ja')
    expect(electron.defaults.has('AppleLanguages')).toBe(false)
  })

  it('leaves the defaults alone off macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    electron.configText = JSON.stringify({ language: 'it' })
    const i18n = await load()
    i18n.settleLanguageBeforeReady()
    i18n.settleLanguageWhenReady()
    expect(i18n.currentLanguage()).toBe('it')
    expect(electron.calls.filter((call) => call !== 'read')).toEqual([])
  })

  it('leaves the defaults alone on an unpackaged macOS run', async () => {
    electron.isPackaged = false
    electron.configText = JSON.stringify({ language: 'it' })
    const i18n = await load()
    i18n.settleLanguageBeforeReady()
    i18n.settleLanguageWhenReady()
    expect(i18n.currentLanguage()).toBe('it')
    expect(electron.calls.filter((call) => call !== 'read')).toEqual([])
  })
})
