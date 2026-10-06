import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const showPlainMessageDialog = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@main/plain-message-dialog.js', () => ({ showPlainMessageDialog }))

const language = vi.hoisted(() => ({ current: 'en' as 'en' | 'de' }))
vi.mock('@main/i18n.js', async () => {
  const { createTranslator } = await import('@shared/i18n/translate')
  return { mainTranslator: () => createTranslator(language.current) }
})

import { notifyCorruptConfig, notifyCorruptSession, notifyStartupFailure } from '@main/startup-dialog'
import { loadCatalogue } from '@shared/i18n/catalogues'
import { NewerFormatError } from '@main/io/format-version'

await loadCatalogue('de')

beforeEach(() => {
  showPlainMessageDialog.mockClear()
  language.current = 'en'
})

describe('startup recovery dialogs', () => {
  it('names where an unreadable settings file was set aside and what TapeBox started with', async () => {
    const owner = {} as BrowserWindow
    await notifyCorruptConfig('/data/config-20260101-000000-000-utc.invalid', owner)

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      owner,
      title: 'Settings could not be read',
      message: expect.stringContaining('/data/config-20260101-000000-000-utc.invalid'),
      detail: expect.stringContaining('default settings'),
    }))
  })

  it('names where an unreadable library file was set aside and what TapeBox started with', async () => {
    await notifyCorruptSession('/data/catalog-20260101-000000-000-utc.invalid')

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Library could not be opened',
      message: expect.stringContaining('/data/catalog-20260101-000000-000-utc.invalid'),
      detail: expect.stringContaining('empty library'),
    }))
  })

  it('speaks the interface language, declaring it for the dialog page', async () => {
    language.current = 'de'
    await notifyStartupFailure(new Error('boom'))

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      language: 'de',
      title: 'TapeBox konnte nicht starten',
      closeLabel: 'OK',
    }))
  })

  it('names a store in a newer format and says it was left as it is', async () => {
    await notifyStartupFailure(new NewerFormatError('/data/catalog.json', 2, 1))

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'File from a newer version of TapeBox',
      message: expect.stringContaining('/data/catalog.json'),
      detail: expect.stringContaining('left exactly as it is'),
    }))
  })
})
