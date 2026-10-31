import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const showPlainMessageDialog = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@main/plain-message-dialog.js', () => ({ showPlainMessageDialog }))

const language = vi.hoisted(() => ({ current: 'en' as 'en' | 'de' }))
vi.mock('@main/i18n.js', async () => {
  const { createTranslator } = await import('@shared/i18n/translate')
  return { mainTranslator: () => createTranslator(language.current) }
})

import { notifyDamagedTapes, notifySideStoreOff, notifyStartupFailure } from '@main/startup-dialog'
import { loadCatalogue } from '@shared/i18n/catalogues'
import { NewerFormatError } from '@main/io/file-header'
import { LaunchRefusedError, RefusedFileError, StoreAccessError } from '@main/io/store-access'

await loadCatalogue('de')

beforeEach(() => {
  showPlainMessageDialog.mockClear()
  language.current = 'en'
})

describe('startup recovery dialogs', () => {
  it('names every refused file in one window, each newer or unreadable, and what to do', async () => {
    await notifyStartupFailure(new LaunchRefusedError([
      { path: '/data/config.json', reason: 'unreadable' },
      { path: '/data/collection/shelf.json', reason: 'newer' },
    ]))

    expect(showPlainMessageDialog).toHaveBeenCalledOnce()
    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'TapeBox could not start',
      message: expect.stringContaining('/data/config.json (could not be read)\n/data/collection/shelf.json (written by a newer version of TapeBox)'),
      detail: expect.stringMatching(/start that version of TapeBox.*repair it, restore it from a backup, or move it out of the way/),
    }))
  })

  it.each([
    [new RefusedFileError('/data/api-keys.json', 'unreadable'), '/data/api-keys.json (could not be read)'],
    [new StoreAccessError('/data/config.json', new Error('EACCES')), '/data/config.json (could not be read)'],
    [new NewerFormatError('/data/shelf.json', 2, 1), '/data/shelf.json (written by a newer version of TapeBox)'],
  ])('names a single refused file the same way', async (error, line) => {
    await notifyStartupFailure(error)
    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'TapeBox could not start', message: expect.stringContaining(line) }))
  })

  it.each([
    ['recordsOff', 'Records are off', 'text file'],
    ['backupsOff', 'Backups are off', 'not keeping backups'],
  ] as const)('says a side store is off for the session, naming it: %s', async (notice, title, text) => {
    const owner = {} as BrowserWindow
    await notifySideStoreOff(notice, '/data/store.sqlite3', owner)
    expect(showPlainMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      owner, title,
      message: expect.stringMatching(new RegExp(`/data/store\\.sqlite3.*${text}`)),
      detail: expect.stringContaining('left exactly as it is'),
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
})
