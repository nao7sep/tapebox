import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

vi.mock('electron', () => ({ Menu: {} }))

import { applicationMenuTemplate } from '@main/menu'
import { LANGUAGES } from '@shared/i18n/languages'
import { createTranslator } from '@shared/i18n/translate'
import { loadAllCatalogues } from '../helpers/i18n'

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.label ? [item.label] : []),
    ...(Array.isArray(item.submenu) ? labels(item.submenu) : []),
  ])
}

const CATALOGUES = await loadAllCatalogues()
const KEYS = new Set(Object.keys(CATALOGUES.en))

describe('application menu', () => {
  it('keeps the standard roles, so every item still sends the system’s own action', () => {
    const template = applicationMenuTemplate(createTranslator('en'), 'darwin')
    expect(template.map((menu) => menu.role)).toEqual(['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu'])
    const edit = template.find((menu) => menu.role === 'editMenu')!.submenu as MenuItemConstructorOptions[]
    expect(edit.map((item) => item.role).filter(Boolean)).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']),
    )
  })

  it.each(['win32', 'linux'])('gives %s no app menu, File → Exit and Window → Close', (platform) => {
    const template = applicationMenuTemplate(createTranslator('en'), platform)
    expect(template.map((menu) => menu.role)).toEqual(['fileMenu', 'editMenu', 'viewMenu', 'windowMenu'])
    const roles = (menu: string) => (template.find((m) => m.role === menu)!.submenu as MenuItemConstructorOptions[]).map((item) => item.role)
    expect(roles('fileMenu')).toEqual(['quit'])
    expect(roles('windowMenu')).toEqual(['minimize', 'zoom', 'close'])
    expect(roles('editMenu')).not.toContain('pasteAndMatchStyle')
    expect(roles('editMenu')).not.toContain('startSpeaking')
  })

  it('gives macOS File → Close Window and Window → Bring All to Front', () => {
    const template = applicationMenuTemplate(createTranslator('en'), 'darwin')
    const roles = (menu: string) => (template.find((m) => m.role === menu)!.submenu as MenuItemConstructorOptions[]).map((item) => item.role)
    expect(roles('fileMenu')).toEqual(['close'])
    expect(roles('windowMenu')).toEqual(['minimize', 'zoom', undefined, 'front'])
  })

  it('titles the Edit menu in the interface language, since macOS adds its own items to it', () => {
    const ja = applicationMenuTemplate(createTranslator('ja'), 'darwin')
    expect(ja.find((menu) => menu.role === 'editMenu')!.label).toBe(CATALOGUES.ja['nativeMenu.edit'])
  })

  it.each(LANGUAGES)('speaks %s on every platform, with no key left showing', (language) => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const shown = labels(applicationMenuTemplate(createTranslator(language), platform))
      expect(shown.filter((label) => KEYS.has(label))).toEqual([])
    }
  })

  // macOS's native About panel would show Electron's default copyright; the app
  // menu's About opens TapeBox's own dialog instead.
  it('opens TapeBox\'s own About from the app menu, not the native panel', () => {
    const onAbout = vi.fn()
    const template = applicationMenuTemplate(createTranslator('en'), 'darwin', onAbout)
    const about = (template[0]!.submenu as MenuItemConstructorOptions[])[0]!
    expect(about.label).toBe('About TapeBox')
    expect(about.role).toBeUndefined()
    ;(about.click as () => void)()
    expect(onAbout).toHaveBeenCalledOnce()
  })

  it('names the app in the About, Hide and Quit items', () => {
    const shown = labels(applicationMenuTemplate(createTranslator('en'), 'darwin'))
    expect(shown).toEqual(expect.arrayContaining(['About TapeBox', 'Hide TapeBox', 'Quit TapeBox']))
  })
})

describe('the About copyright', () => {
  it.each(LANGUAGES)('is the fleet\'s one line in %s, with a middle dot', (language) => {
    expect(CATALOGUES[language]['about.copyright']).toMatch(/^© 2026 Yoshinao Inoguchi · GNU GPL v3 \S/)
  })
})
