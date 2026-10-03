import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RECORDS_WINDOW_MIN_HEIGHT, RECORDS_WINDOW_MIN_WIDTH } from '@shared/layout'

// The Records window is one durable secondary window with its own placement
// (window-conventions, Placement): opening it again brings it forward.

const electron = vi.hoisted(() => ({
  created: [] as unknown[],
  workAreas: [{ x: 0, y: 0, width: 2560, height: 1392 }],
  normalBounds: { x: 200, y: 100, width: 1240, height: 820 },
  clearPersistedState: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeContents extends Emitter {
    send = vi.fn()
    isDestroyed = () => false
    getURL = () => 'file:///records.html'
    setWindowOpenHandler = vi.fn()
  }
  class FakeWindow extends Emitter {
    static clearPersistedState = electron.clearPersistedState
    webContents = new FakeContents()
    destroyed = false
    minimized = false
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super()
      electron.created.push(this)
    }
    isDestroyed = () => this.destroyed
    destroy = vi.fn(() => {
      this.destroyed = true
      this.emit('closed')
    })
    isMinimized = () => this.minimized
    isMaximized = () => false
    isFullScreen = () => false
    isFocused = () => false
    restore = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    getNormalBounds = () => electron.normalBounds
    getBounds = () => electron.normalBounds
    getContentBounds = () => electron.normalBounds
    getMinimumSize = () => [0, 0]
    getSize = () => [electron.normalBounds.width, electron.normalBounds.height]
    setMinimumSize = vi.fn()
    setSize = vi.fn()
    loadFile = vi.fn(async () => {})
    loadURL = vi.fn(async () => {})
  }
  return {
    app: Object.assign(new Emitter(), { isActive: () => true }),
    BrowserWindow: FakeWindow,
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getAllDisplays: () => electron.workAreas.map((workArea) => ({ workArea })),
      getDisplayMatching: () => ({ workAreaSize: { width: 2560, height: 1392 } }),
      on: vi.fn(),
      off: vi.fn(),
    },
  }
})
vi.mock('@main/i18n', () => ({ mainTranslator: () => ({ t: (key: string) => (key === 'records.title' ? 'Records' : key) }) }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

type Fake = EventEmitter & {
  options: Electron.BrowserWindowConstructorOptions
  webContents: EventEmitter & { send: ReturnType<typeof vi.fn> }
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  minimized: boolean
}

const windows = () => electron.created as Fake[]

beforeEach(() => {
  vi.resetModules()
  electron.created = []
  electron.normalBounds = { x: 200, y: 100, width: 1240, height: 820 }
  electron.clearPersistedState.mockClear()
  delete process.env['ELECTRON_RENDERER_URL']
})

describe('Records window', () => {
  it('has a stable identity, Electron bounds persistence and the derived minimum', async () => {
    const { recordsWindowOptions } = await import('@main/records-window')
    const options = recordsWindowOptions('Records', '/preload.cjs', '#ffffff')
    expect(options).toMatchObject({
      name: 'records',
      windowStatePersistence: { bounds: true, displayMode: process.platform === 'win32' },
      title: 'Records',
      minWidth: RECORDS_WINDOW_MIN_WIDTH,
      minHeight: RECORDS_WINDOW_MIN_HEIGHT,
      show: false,
      backgroundColor: '#ffffff',
    })
    expect(options.webPreferences).toMatchObject({ preload: '/preload.cjs', sandbox: true, contextIsolation: true })
  })

  it('opens one window on its own page, and brings that one forward when opened again', async () => {
    const { openRecordsWindow } = await import('@main/records-window')
    await openRecordsWindow()
    expect(windows()).toHaveLength(1)
    const [window] = windows()
    expect(window!.options.title).toBe('Records')
    expect(window!.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[\\/]records\.html$/))
    expect(window!.show).not.toHaveBeenCalled()
    window!.emit('ready-to-show')
    expect(window!.show).toHaveBeenCalledOnce()

    window!.minimized = true
    await openRecordsWindow()
    expect(windows()).toHaveLength(1)
    expect(window!.restore).toHaveBeenCalledOnce()
    expect(window!.focus).toHaveBeenCalledOnce()
  })

  it('opens a new window once the last one has closed', async () => {
    const { openRecordsWindow } = await import('@main/records-window')
    await openRecordsWindow()
    windows()[0]!.emit('closed')
    await openRecordsWindow()
    expect(windows()).toHaveLength(2)
  })

  it('loads the development server page when one is running', async () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://127.0.0.1:27143'
    const { openRecordsWindow } = await import('@main/records-window')
    await openRecordsWindow()
    expect(windows()[0]!.loadURL).toHaveBeenCalledWith('http://127.0.0.1:27143/records.html')
  })

  it('falls back to the designed placement when the saved one is off-screen', async () => {
    electron.normalBounds = { x: 5000, y: 3000, width: 1240, height: 820 }
    const { openRecordsWindow } = await import('@main/records-window')
    await openRecordsWindow()
    expect(electron.clearPersistedState).toHaveBeenCalledWith('records')
    expect(windows()).toHaveLength(2)
  })

  it('signals a stored record only while it is open', async () => {
    const { notifyRecordsChanged, openRecordsWindow } = await import('@main/records-window')
    notifyRecordsChanged()
    await openRecordsWindow()
    const [window] = windows()
    notifyRecordsChanged()
    expect(window!.webContents.send).toHaveBeenCalledExactlyOnceWith('records:changed', null)
    window!.emit('closed')
    notifyRecordsChanged()
    expect(window!.webContents.send).toHaveBeenCalledOnce()
  })

  it('keeps the page from navigating away or opening windows', async () => {
    const { openRecordsWindow } = await import('@main/records-window')
    await openRecordsWindow()
    const contents = windows()[0]!.webContents as unknown as EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn> }
    const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as () => unknown
    expect(handler()).toEqual({ action: 'deny' })
    const away = { preventDefault: vi.fn() }
    contents.emit('will-navigate', away, 'https://example.com')
    expect(away.preventDefault).toHaveBeenCalled()
    const reload = { preventDefault: vi.fn() }
    contents.emit('will-navigate', reload, 'file:///records.html')
    expect(reload.preventDefault).not.toHaveBeenCalled()
  })
})
