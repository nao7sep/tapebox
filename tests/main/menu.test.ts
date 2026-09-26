import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

vi.mock('electron', () => ({ Menu: {} }))

import { applicationMenuTemplate } from '@main/menu'
import { CATALOGUES } from '@shared/i18n/catalogues'
import { LANGUAGES } from '@shared/i18n/languages'
import { createTranslator } from '@shared/i18n/translate'

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.label ? [item.label] : []),
    ...(Array.isArray(item.submenu) ? labels(item.submenu) : []),
  ])
}

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

  it('names the app in the About, Hide and Quit items', () => {
    const shown = labels(applicationMenuTemplate(createTranslator('en'), 'darwin'))
    expect(shown).toEqual(expect.arrayContaining(['About TapeBox', 'Hide TapeBox', 'Quit TapeBox']))
  })
})
