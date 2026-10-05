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
  it('keeps config quarantine paths in diagnostics only', async () => {
    const owner = {} as BrowserWindow
    await notifyCorruptConfig(owner)

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      owner,
      title: 'Settings could not be read',
      detail: expect.stringContaining('recorded in the session log'),
    }))
    expect(JSON.stringify(showPlainMessageDialog.mock.calls[0])).not.toMatch(/\/private\/tmp|\.invalid/)
  })

  it('keeps session quarantine paths in diagnostics only', async () => {
    await notifyCorruptSession()

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Library could not be opened',
      detail: expect.stringContaining('recorded in the session log'),
    }))
    expect(JSON.stringify(showPlainMessageDialog.mock.calls[0])).not.toMatch(/\/private\/tmp|\.invalid/)
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
