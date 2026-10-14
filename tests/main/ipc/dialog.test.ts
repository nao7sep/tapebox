import { beforeEach, describe, expect, it, vi } from 'vitest'

// A file or folder picker opens above the window that asked for it, not whichever
// app window happens to have focus (window-conventions).

const handlers = vi.hoisted(() => new Map<string, (request: unknown, event: unknown) => unknown>())
const electron = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  fromWebContents: vi.fn(),
  getFocusedWindow: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents, getFocusedWindow: electron.getFocusedWindow },
  dialog: { showOpenDialog: electron.showOpenDialog },
}))
vi.mock('@main/ipc/handle', () => ({ handle: (channel: string, handler: (request: unknown, event: unknown) => unknown) => { handlers.set(channel, handler) } }))
vi.mock('@main/i18n', () => ({ mainTranslator: () => ({ t: (key: string) => key }) }))

const { registerDialogHandlers } = await import('@main/ipc/dialog')
registerDialogHandlers()

const records = { isDestroyed: () => false }
const main = { isDestroyed: () => false }

beforeEach(() => {
  electron.showOpenDialog.mockReset().mockResolvedValue({ canceled: true, filePaths: [] })
  electron.fromWebContents.mockReset().mockReturnValue(records)
  electron.getFocusedWindow.mockReset().mockReturnValue(main)
})

describe('pickers', () => {
  it.each(['dialog:pickDirectory', 'dialog:pickFiles'])('%s opens over the requesting window', async (channel) => {
    const sender = {}
    await handlers.get(channel)!({ title: 'Choose' }, { sender })
    expect(electron.fromWebContents).toHaveBeenCalledWith(sender)
    expect(electron.showOpenDialog).toHaveBeenCalledWith(records, expect.objectContaining({ title: 'Choose' }))
  })

  it('opens standalone when the requesting window is gone', async () => {
    electron.fromWebContents.mockReturnValue(null)
    await handlers.get('dialog:pickDirectory')!({ title: 'Choose' }, { sender: {} })
    expect(electron.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Choose' }))
    expect(electron.showOpenDialog.mock.lastCall).toHaveLength(1)
  })
})
