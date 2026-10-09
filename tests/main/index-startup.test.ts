import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The Electron entry's wiring, with every store, service and window substituted:
// a second launch or Dock activation that arrives while the language is still
// loading must not create a window before the stores, IPC and media server are
// ready, and startup then creates the one owner window. Forced exits end the
// download tools first.

const appHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const windows = vi.hoisted(() => [] as Array<{ focus: ReturnType<typeof vi.fn> }>)
const order = vi.hoisted(() => [] as string[])
const language = vi.hoisted(() => ({ release: (() => {}) as () => void }))

vi.mock('electron', () => {
  class BrowserWindow {
    readonly webContents = { setWindowOpenHandler: vi.fn() }
    readonly focus = vi.fn()
    constructor() {
      order.push('window')
      windows.push(this)
    }
    on(): this { return this }
    once(): this { return this }
    isDestroyed(): boolean { return false }
    isMinimized(): boolean { return false }
    isVisible(): boolean { return true }
    restore(): void {}
    show(): void {}
    loadFile(): Promise<void> { return Promise.resolve() }
    loadURL(): Promise<void> { return Promise.resolve() }
  }
  return {
    app: {
      requestSingleInstanceLock: () => true,
      on: (event: string, handler: (...args: unknown[]) => unknown) => { appHandlers.set(event, handler) },
      whenReady: () => Promise.resolve(),
      quit: vi.fn(),
      exit: vi.fn(),
      isPackaged: false,
    },
    BrowserWindow,
    powerMonitor: { on: vi.fn() },
    shell: { openExternal: vi.fn() },
  }
})

const step = (name: string) => vi.fn(async () => { order.push(name) })
vi.mock('@main/paths', () => ({ ensureDirs: vi.fn(async () => {}), sweepAbandonedStaging: vi.fn(async () => {}) }))
vi.mock('@main/startup-dialog', () => ({ notifyCorruptConfig: vi.fn(), notifyCorruptSession: vi.fn(), notifyStartupFailure: vi.fn() }))
vi.mock('@main/io/logger', () => ({ initLogger: vi.fn(), isDebugEnabled: () => false, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/io/records', () => ({ closeRecords: vi.fn(async () => {}), flushRecordsBeforeExit: vi.fn(() => { order.push('records-drain') }), onRecordStored: vi.fn(), openRecords: () => 'session' }))
vi.mock('@main/io/records-read', () => ({ closeRecordsReader: vi.fn(async () => {}) }))
vi.mock('@main/records-window', () => ({ notifyRecordsChanged: vi.fn() }))
vi.mock('@main/store/config', () => ({ getSettings: () => ({ language: 'en', theme: 'system' }), loadSettings: vi.fn(async () => ({ status: 'loaded' })) }))
vi.mock('@main/store/dependencies', () => ({ loadDependencies: vi.fn(async () => {}) }))
vi.mock('@main/store/session', () => ({ loadSession: vi.fn(async () => { order.push('session'); return { status: 'loaded' } }), persistNow: vi.fn(async () => true) }))
vi.mock('@main/store/layout', () => ({ loadLayout: step('layout'), persistNow: vi.fn(async () => {}) }))
vi.mock('@main/ipc/index', () => ({ registerIpcHandlers: vi.fn(() => { order.push('ipc') }) }))
vi.mock('@main/ipc/binaries', () => ({ resumeBinaryOperations: vi.fn(), shutdownBinaryOperations: vi.fn(async () => {}) }))
vi.mock('@main/queue/manager', () => ({ start: vi.fn(() => { order.push('queue') }), shutdown: vi.fn(async () => {}), resumeAfterQuit: vi.fn() }))
vi.mock('@main/ipc/scan', () => ({ cancelAllScans: vi.fn(async () => {}), resumeScans: vi.fn() }))
vi.mock('@main/work-registry', () => ({ cancelAllWork: vi.fn(async () => {}), resumeWork: vi.fn() }))
vi.mock('@main/media-server', () => ({ startMediaServer: step('media'), stopMediaServer: vi.fn(async () => {}) }))
vi.mock('@main/power-blocker', () => ({ releaseWakeLock: vi.fn() }))
vi.mock('@main/window-options', () => ({ windowOptions: () => ({}) }))
vi.mock('@main/theme', () => ({ applyThemePreference: vi.fn(), followOsThemeChanges: vi.fn(), windowBackground: () => '#000' }))
vi.mock('@main/window-state-recovery', () => ({ createWindowWithUsablePersistedBounds: (_key: string, make: () => unknown) => make() }))
vi.mock('@main/window-minimum', () => ({ configureWindowMinimum: vi.fn() }))
vi.mock('@main/window-activity', () => ({ configureWindowActivity: vi.fn() }))
vi.mock('@main/store/backupStore', () => ({ closeBackupStore: vi.fn(async () => {}) }))
vi.mock('@main/plain-message-dialog', () => ({ showPlainMessageDialog: vi.fn() }))
vi.mock('@main/force-exit', () => ({ forceExitProcess: vi.fn(() => { order.push('force-exit') }) }))
vi.mock('@main/io/spawn', () => ({ killOwnedProcessesNow: vi.fn(() => { order.push('kill-tools') }) }))
vi.mock('@main/i18n', () => ({
  applyLanguagePreference: vi.fn(async () => {}),
  registerLanguageHandlers: vi.fn(),
  mainTranslator: () => ({ language: 'en', t: (key: string) => key }),
  settleLanguageBeforeReady: vi.fn(),
  settleLanguageWhenReady: () => new Promise<void>((resolve) => { language.release = resolve }),
}))

let processHandlers: Array<[string, (...args: unknown[]) => void]> = []

beforeAll(async () => {
  const before = new Map(['uncaughtException', 'unhandledRejection', 'exit'].map((event) => [event, process.listeners(event as 'exit')]))
  await import('@main/index')
  for (const [event, listeners] of before) {
    for (const listener of process.listeners(event as 'exit')) {
      if (!listeners.includes(listener)) processHandlers.push([event, listener as (...args: unknown[]) => void])
    }
  }
})

afterAll(() => {
  for (const [event, listener] of processHandlers) process.off(event, listener)
  processHandlers = []
})

describe('the Electron entry', () => {
  it('creates no window for a second launch or activation during the language load, then exactly one', async () => {
    await vi.waitFor(() => expect(appHandlers.has('activate')).toBe(true))
    appHandlers.get('second-instance')!()
    appHandlers.get('activate')!()
    expect(windows).toHaveLength(0)

    language.release()
    await vi.waitFor(() => expect(windows).toHaveLength(1))
    expect(order.slice(0, order.indexOf('window'))).toEqual(expect.arrayContaining(['session', 'layout', 'media', 'ipc', 'queue']))

    appHandlers.get('second-instance')!()
    expect(windows).toHaveLength(1)
    expect(windows[0]!.focus).toHaveBeenCalledOnce()
  })

  it('lands the fatal record, then kills the download tools before a forced exit', () => {
    order.length = 0
    const uncaught = processHandlers.find(([event]) => event === 'uncaughtException')![1]
    uncaught(new Error('fatal'))
    expect(order).toEqual(['records-drain', 'kill-tools', 'force-exit'])
    expect(processHandlers.map(([event]) => event), 'no exit hook: every way out closes the records itself').not.toContain('exit')
  })
})
