import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const showPlainMessageDialog = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@main/plain-message-dialog.js', () => ({ showPlainMessageDialog }))

const language = vi.hoisted(() => ({ current: 'en' as 'en' | 'de' }))
vi.mock('@main/i18n.js', async () => {
  const { createTranslator } = await import('@shared/i18n/translate')
  return { mainTranslator: () => createTranslator(language.current) }
})

import { notifyCorruptConfig, notifyCorruptSession, notifyDamagedTapes, notifyStartupFailure } from '@main/startup-dialog'
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
    await notifyCorruptSession('/data/shelf-20260101-000000-000-utc.invalid')

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Library could not be opened',
      message: expect.stringContaining('/data/shelf-20260101-000000-000-utc.invalid'),
      detail: expect.stringContaining('tapes are all there'),
    }))
  })

  it('names each tape file that could not be read and says it was left as it is', async () => {
    const owner = {} as BrowserWindow
    await notifyDamagedTapes(['/data/inbox/Tape000001/tape.json', '/data/shelf/Tape000002/tape.json'], owner)

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      owner,
      title: 'Some tapes could not be read',
      message: expect.stringContaining('/data/inbox/Tape000001/tape.json\n/data/shelf/Tape000002/tape.json'),
      detail: expect.stringContaining('left exactly as they are'),
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
    await notifyStartupFailure(new NewerFormatError('/data/shelf.json', 2, 1))

    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'File from a newer version of TapeBox',
      message: expect.stringContaining('/data/shelf.json'),
      detail: expect.stringContaining('left exactly as it is'),
    }))
  })
})
