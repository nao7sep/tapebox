import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { showPlainMessageDialog } from '@main/plain-message-dialog'
import { EXIT_DEADLINE_MS } from '@main/quit'

// The Electron entry's platform quit routes. Closing the main window quits on
// every platform, including macOS.
//
// An OS logout, restart or shutdown delivered into the Electron entry's own
// handlers, with every store, service and window substituted: macOS and Linux
// raise powerMonitor's 'shutdown' before their quit arrives, Windows raises the
// main window's 'session-end' and no quit event. Neither route may ask, veto or
// delay the OS: the macOS quit never shows the failed-save question and ends
// within the exit deadline, and the Windows handler drains the records,
// kills the owned download tools and exits before it returns, with no
// synchronous collection write. quit.test.ts covers the quit's own steps and deadline.

type Handler = (...args: unknown[]) => unknown

const state = vi.hoisted(() => {
  // Tests wait for what the entry does by its effects, never by a deadline: each
  // recorded step wakes the waiters, which check their condition again.
  const waiters: Array<() => void> = []
  const changed = (): void => { for (const wake of waiters.splice(0)) wake() }
  class Steps extends Array<string> {
    override push(...steps: string[]): number { const length = super.push(...steps); changed(); return length }
  }
  return {
  waiters,
  changed,
  app: new Map<string, Handler>(),
  power: new Map<string, Handler>(),
  windows: [] as Array<{ handlers: Map<string, Handler>; renderer: Map<string, Handler> }>,
  order: new Steps(),
  releaseLanguage: (() => {}) as () => void,
  stopStalls: false,
  focused: null as unknown,
  working: false,
  minimized: false,
  about: (() => {}) as () => void,
  reload: ((_window: unknown, _force: boolean) => {}) as (window: unknown, force: boolean) => void,
  reloadPage: vi.fn(() => changed()),
  reloadIgnoringCache: vi.fn(() => changed()),
  boot: [] as string[],
  blockers: new Set<number>(),
  nextBlocker: 0,
  }
})

/** Resolves once `check` holds, checking it first and again after each step. */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise<void>((resolve) => state.waiters.push(resolve))
}

vi.mock('electron', () => {
  class BrowserWindow {
    static getFocusedWindow(): unknown { return state.focused }
    readonly handlers = new Map<string, Handler>()
    readonly renderer = new Map<string, Handler>()
    readonly webContents = { reload: state.reloadPage, reloadIgnoringCache: state.reloadIgnoringCache, on: (event: string, handler: Handler) => { this.renderer.set(event, handler) }, setWindowOpenHandler: vi.fn(), send: vi.fn(), isDestroyed: () => false }
    constructor() { state.windows.push(this); state.changed() }
    on(event: string, handler: Handler): this { this.handlers.set(event, handler); return this }
    once(event: string, handler: Handler): this { return this.on(event, handler) }
    isDestroyed(): boolean { return false }
    isMinimized(): boolean { return state.minimized }
    isVisible(): boolean { return true }
    focus(): void {}
    restore(): void {}
    show(): void {}
    loadFile(): Promise<void> { return Promise.resolve() }
    loadURL(): Promise<void> { return Promise.resolve() }
  }
  return {
    app: {
      requestSingleInstanceLock: () => { state.boot.push('lock'); return true },
      setPath: (name: string, path: string) => { state.boot.push(`setPath ${name} ${path}`) },
      on: (event: string, handler: Handler) => { state.app.set(event, handler) },
      whenReady: () => Promise.resolve(),
      quit: vi.fn(),
      exit: vi.fn(() => { state.order.push('app-exit') }),
      isPackaged: false,
    },
    BrowserWindow,
    powerMonitor: { on: (event: string, handler: Handler) => { state.power.set(event, handler); state.changed() } },
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: {
      start: vi.fn(() => { const id = ++state.nextBlocker; state.blockers.add(id); return id }),
      stop: vi.fn((id: number) => state.blockers.delete(id)),
      isStarted: (id: number) => state.blockers.has(id),
    },
  }
})

const step = (name: string) => vi.fn(async () => { state.order.push(name) })
vi.mock('@main/paths', () => ({ ensureDirs: vi.fn(async () => {}), sweepAbandonedStaging: vi.fn(async () => {}), paths: { electronProfile: '/data-root/electron' } }))
vi.mock('@main/startup-dialog', () => ({ notifyCorruptConfig: vi.fn(), notifyCorruptSession: vi.fn(), notifySettingsKept: vi.fn(), notifyStartupFailure: vi.fn() }))
vi.mock('@main/io/logger', () => ({ initLogger: vi.fn(), isDebugEnabled: () => false, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/io/records', () => ({ flushRecords: vi.fn(async () => {}), closeRecords: step('close-records'), flushRecordsBeforeExit: vi.fn(() => { state.order.push('records-drain') }), onRecordStored: vi.fn(), openRecords: () => 'session' }))
vi.mock('@main/records-window', () => ({ notifyRecordsChanged: vi.fn() }))
vi.mock('@main/store/config', () => ({ getSettings: () => ({ language: 'en', theme: 'system', keepAwakeWhilePlaying: true }), loadSettings: vi.fn(async () => ({ status: 'loaded' })) }))
vi.mock('@main/store/dependencies', () => ({ loadDependencies: vi.fn(async () => {}) }))
// Every collection save fails: a user's quit would ask; a session end must not.
vi.mock('@main/store/session', () => ({ loadSession: vi.fn(async () => ({ status: 'loaded' })), persistNow: vi.fn(async () => { state.order.push('save-collection'); return false }) }))
vi.mock('@main/store/layout', () => ({ loadLayout: vi.fn(async () => {}), persistNow: vi.fn(async () => {}) }))
vi.mock('@main/ipc/index', () => ({ registerIpcHandlers: vi.fn() }))
vi.mock('@main/ipc/binaries', () => ({ resumeBinaryOperations: vi.fn(), shutdownBinaryOperations: vi.fn(async () => {}) }))
vi.mock('@main/queue/manager', () => ({
  start: vi.fn(),
  shutdown: vi.fn(() => {
    state.order.push('stop-downloads')
    return state.stopStalls ? new Promise<void>(() => {}) : Promise.resolve()
  }),
  resumeAfterQuit: vi.fn(),
  hasActiveJobs: () => state.working,
}))
vi.mock('@main/binaries/manager', () => ({ hasInstalls: () => false }))
vi.mock('@main/ipc/scan', () => ({ cancelAllScans: vi.fn(async () => {}), resumeScans: vi.fn(), hasActiveScans: () => false }))
vi.mock('@main/work-registry', () => ({ cancelAllWork: vi.fn(async () => {}), resumeWork: vi.fn(() => { state.order.push('resume') }), hasRunningWork: () => false }))
vi.mock('@main/media-server', () => ({ startMediaServer: vi.fn(async () => {}), stopMediaServer: vi.fn(async () => {}) }))
vi.mock('@main/window-options', () => ({ windowOptions: () => ({}) }))
vi.mock('@main/theme', () => ({ applyThemePreference: vi.fn(), followOsThemeChanges: vi.fn(), windowBackground: () => '#000' }))
vi.mock('@main/window-state-recovery', () => ({ createWindowWithUsablePersistedBounds: (_key: string, make: () => unknown) => make() }))
vi.mock('@main/window-minimum', () => ({ configureWindowMinimum: vi.fn() }))
vi.mock('@main/window-activity', () => ({ configureWindowActivity: vi.fn() }))
vi.mock('@main/window-close', () => ({ configureWindowClose: vi.fn(), registerDraftAnswers: vi.fn(), settleWindowDrafts: vi.fn(async () => { state.order.push('drafts'); return true }) }))
vi.mock('@main/store/backupStore', () => ({ closeBackupStore: vi.fn(async () => {}) }))
vi.mock('@main/menu', () => ({ setAboutRequest: (request: () => void) => { state.about = request }, setReloadRequest: (request: typeof state.reload) => { state.reload = request } }))
vi.mock('@main/plain-message-dialog', () => ({ showPlainMessageDialog: vi.fn(async (options: { title: string }) => { state.order.push(options.title === 'quit.workRunning.title' ? 'work-dialog' : 'dialog'); return 'cancel' }) }))
vi.mock('@main/force-exit', () => ({ forceExitProcess: vi.fn(() => { state.order.push('force-exit') }) }))
vi.mock('@main/io/spawn', () => ({ killOwnedProcessesNow: vi.fn(() => { state.order.push('kill-tools') }) }))
vi.mock('@main/i18n', () => ({
  applyLanguagePreference: vi.fn(async () => {}),
  registerLanguageHandlers: vi.fn(),
  mainTranslator: () => ({ language: 'en', t: (key: string) => key }),
  settleLanguageBeforeReady: vi.fn(),
  settleLanguageWhenReady: () => new Promise<void>((resolve) => { state.releaseLanguage = resolve }),
}))

let processHandlers: Array<[string, (...args: unknown[]) => void]> = []

/** A fresh Electron entry, ready but still settling its language. */
async function boot(): Promise<void> {
  state.reloadPage.mockClear()
  state.reloadIgnoringCache.mockClear()
  state.blockers.clear()
  state.app.clear()
  state.power.clear()
  state.boot.length = 0
  state.windows.length = 0
  state.order.length = 0
  vi.resetModules()
  const events = ['uncaughtException', 'unhandledRejection'] as const
  const before = new Map(events.map((event) => [event, process.listeners(event)]))
  await import('@main/index')
  for (const [event, listeners] of before) {
    for (const listener of process.listeners(event)) {
      if (!listeners.includes(listener)) processHandlers.push([event, listener as (...args: unknown[]) => void])
    }
  }
  await until(() => state.power.has('shutdown'))
}

/** A fresh Electron entry, started up to its main window. */
async function launch(): Promise<{ handlers: Map<string, Handler>; renderer: Map<string, Handler> }> {
  await boot()
  state.releaseLanguage()
  await until(() => state.windows.length === 1)
  state.order.length = 0
  return state.windows[0]!
}

afterEach(() => {
  for (const [event, listener] of processHandlers) process.off(event, listener)
  processHandlers = []
  state.stopStalls = false
  state.focused = null
  state.working = false
  state.minimized = false
  vi.restoreAllMocks()
  vi.mocked(app.quit).mockClear()
})

describe('closing the main window', () => {
  it('starts the quit, on every platform', async () => {
    const win = await launch()
    const configure = vi.mocked((await import('@main/window-close')).configureWindowClose)
    expect(configure.mock.lastCall![0]).toBe(win)
    configure.mock.lastCall![1]()
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it.each(['darwin', 'win32', 'linux'] as const)('ends the app when the last window is gone on %s', async (platform) => {
    const win = await launch()
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    win.handlers.get('closed')!()
    expect(app.quit).toHaveBeenCalledOnce()
    state.app.get('window-all-closed')!()
    expect(app.quit).toHaveBeenCalledTimes(2)
  })
})

// A user's quit asks about drafts, then about running work, before anything is
// saved or stopped (unsaved-edits-conventions); a session end never asks.
describe('the quit questions', () => {
  it('offers the unresponsive notice with safe dismissal before stopping work', async () => {
    await launch()
    const settle = vi.mocked((await import('@main/window-close')).settleWindowDrafts)
    settle.mockImplementationOnce(async (_window, signal, _standalone, unavailable) => unavailable(signal))
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    await until(() => state.order.includes('dialog'))
    expect(vi.mocked(showPlainMessageDialog).mock.lastCall![0]).toMatchObject({
      title: 'TapeBox',
      message: 'quit.unresponsive.message',
      closeLabel: 'common.cancel',
      actions: [{ id: 'quit-anyway', label: 'quit.collectionNotSaved.quitAnyway', danger: true }],
    })
    expect(state.order).not.toContain('save-collection')
    expect(state.order).not.toContain('stop-downloads')
  })

  it('asks about running downloads before stopping them, and Cancel stops nothing', async () => {
    await launch()
    state.working = true
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    // Cancel resumes the app, the quit's last act when it stops nothing.
    await until(() => state.order.includes('resume'))
    expect(state.order).toEqual(['drafts', 'work-dialog', 'resume'])
  })

  it('asks nothing about work when none is running', async () => {
    await launch()
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    await until(() => state.order.includes('save-collection'))
    expect(state.order[0]).toBe('drafts')
    expect(state.order).not.toContain('work-dialog')
  })

  it('never asks at a session end', async () => {
    await launch()
    state.working = true
    state.power.get('shutdown')!({ preventDefault: vi.fn() })
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    await until(() => state.order.at(-1) === 'app-exit')
    expect(state.order).not.toContain('drafts')
    expect(state.order).not.toContain('work-dialog')
  })
})

describe('an OS session end delivered to the Electron entry', () => {
  it('Windows: drains the records, kills the download tools and exits before the handler returns', async () => {
    const win = await launch()
    expect(win.handlers.has('query-session-end'), 'nothing may veto a Windows logoff').toBe(false)

    win.handlers.get('session-end')!({ preventDefault: vi.fn(), reasons: ['logoff'] })
    expect(state.order).toEqual(['records-drain', 'kill-tools', 'force-exit'])

    // A later quit event from the dying session starts nothing.
    const late = { preventDefault: vi.fn() }
    state.app.get('before-quit')!(late)
    expect(late.preventDefault).toHaveBeenCalledOnce()
    expect(state.order).toEqual(['records-drain', 'kill-tools', 'force-exit'])
  })

  it('macOS: the quit after the shutdown signal never asks and exits normally', async () => {
    await launch()
    const shutdown = { preventDefault: vi.fn() }
    state.power.get('shutdown')!(shutdown)
    expect(shutdown.preventDefault, 'nothing may delay the OS shutdown').not.toHaveBeenCalled()

    const quitEvent = { preventDefault: vi.fn() }
    state.app.get('before-quit')!(quitEvent)
    await until(() => state.order.at(-1) === 'app-exit')
    expect(state.order).not.toContain('dialog')
    expect(state.order).toEqual(['save-collection', 'stop-downloads', 'save-collection', 'close-records', 'kill-tools', 'app-exit'])
  })

  it('macOS: work that stalls at a session end is forced off at the exit deadline', async () => {
    await launch()
    state.stopStalls = true
    state.power.get('shutdown')!({ preventDefault: vi.fn() })

    vi.useFakeTimers()
    try {
      state.app.get('before-quit')!({ preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(EXIT_DEADLINE_MS - 1)
      expect(state.order).not.toContain('force-exit')
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
    expect(state.order).not.toContain('dialog')
    expect(state.order.slice(-2)).toEqual(['kill-tools', 'force-exit'])
  })
})

// Startup takes its next step only after a running quit: a quit that ends the app
// meets no window, and a cancelled one lets startup carry on.
describe('a quit that begins during startup', () => {
  it('ends the app before startup opens the main window', async () => {
    await boot()
    state.power.get('shutdown')!({ preventDefault: vi.fn() })
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    state.releaseLanguage()
    await until(() => state.order.at(-1) === 'app-exit')
    expect(state.windows).toHaveLength(0)
  })

  it('lets startup open the main window once the quit is cancelled', async () => {
    await boot()
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    state.releaseLanguage()
    await until(() => state.windows.length === 1)
    expect(state.order).toEqual(['drafts', 'save-collection', 'dialog', 'resume'])
  })
})

// The failed-save question opens at the user's quit, so it sits above the window
// they quit from (window-conventions): Records when it has focus, else the main window.
describe('the failed-save question at a user quit', () => {
  it('opens above the focused window', async () => {
    await launch()
    const records = { name: 'records' }
    state.focused = records
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    await until(() => state.order.includes('dialog'))
    expect(vi.mocked(showPlainMessageDialog).mock.lastCall![0].owner).toBe(records)
  })

  it('stands alone rather than bring back a minimized main window', async () => {
    await launch()
    state.minimized = true
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    await until(() => state.order.includes('dialog'))
    expect(vi.mocked(showPlainMessageDialog).mock.lastCall![0].owner).toBeUndefined()
  })

  it('opens above the main window when no app window has focus', async () => {
    const main = await launch()
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    await until(() => state.order.includes('dialog'))
    expect(vi.mocked(showPlainMessageDialog).mock.lastCall![0].owner).toBe(main)
  })
})

// The app menu's About opens the main window's own About dialog.
describe('the app menu About', () => {
  it('asks the main window to show its About dialog', async () => {
    const win = await launch() as unknown as { webContents: { send: ReturnType<typeof vi.fn> } }
    state.about()
    expect(win.webContents.send).toHaveBeenCalledWith('app:showAbout', null)
  })
})

// Electron's profile, window placement and single-instance lock live under the
// storage root, set before the lock reads userData, so a relocated root keeps its own.
describe('the Electron profile', () => {
  it('moves under the storage root before the single-instance lock', async () => {
    await launch()
    expect(state.boot).toEqual(['setPath userData /data-root/electron', 'lock'])
  })
})


describe('playback assertion lifetime', () => {
  it('keeps the actual assertion when final-save failure cancels Quit', async () => {
    await launch()
    const { setVideoPlaying } = await import('@main/power-blocker')
    const { persistNow } = await import('@main/store/session')
    vi.mocked(persistNow).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    setVideoPlaying(true)
    const ids = [...state.blockers]
    state.app.get('before-quit')!({ preventDefault: vi.fn() })
    await until(() => state.order.includes('dialog'))
    expect(state.order).toContain('stop-downloads')
    expect([...state.blockers]).toEqual(ids)
    expect(state.blockers.size).toBe(1)
    setVideoPlaying(false)
    expect(state.blockers.size).toBe(0)
  })

  it('releases the assertion on renderer failure and can reacquire after recovery', async () => {
    const window = await launch()
    const { setVideoPlaying, reconcileWakeLock } = await import('@main/power-blocker')
    setVideoPlaying(true)
    expect(state.blockers.size).toBe(1)
    window.renderer.get('render-process-gone')!()
    reconcileWakeLock()
    expect(state.blockers.size).toBe(0)
    setVideoPlaying(true)
    expect(state.blockers.size).toBe(1)
    window.renderer.get('destroyed')!()
    expect(state.blockers.size).toBe(0)
  })
})


describe('renderer reload consent', () => {
  it.each([false, true])('asks about main-window drafts without stopping background work (force: %s)', async (force) => {
    const window = await launch()
    state.working = true
    const settle = vi.mocked((await import('@main/window-close')).settleWindowDrafts)
    settle.mockResolvedValueOnce(false)
    state.reload(window, force)
    await Promise.resolve()
    expect(state.reloadPage).not.toHaveBeenCalled()
    expect(state.reloadIgnoringCache).not.toHaveBeenCalled()
    settle.mockResolvedValueOnce(true)
    state.reload(window, force)
    await until(() => (force ? state.reloadIgnoringCache : state.reloadPage).mock.calls.length === 1)
    expect(state.order).not.toContain('stop-downloads')
    expect(state.order).not.toContain('save-collection')
  })
})
