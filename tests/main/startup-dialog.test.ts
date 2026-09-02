import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const showPlainMessageDialog = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@main/plain-message-dialog.js', () => ({ showPlainMessageDialog }))

import { notifyCorruptConfig, notifyCorruptSession } from '@main/startup-dialog'

beforeEach(() => showPlainMessageDialog.mockClear())

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
})
