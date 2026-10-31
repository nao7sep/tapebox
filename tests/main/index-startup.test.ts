import { waitForFixture } from '../helpers/fixture-readiness'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { forgetInstalledVersion, readInstalledVersion } from '@main/binaries/installed-version'
import { openExternalPlayer } from '@main/io/external-player'
import { killOwnedProcessesNow } from '@main/io/spawn'

// The Electron entry's wiring, with every store, service and window substituted:
// a second launch or Dock activation that arrives while the language is still
// loading must not create a window before the stores, IPC and media server are
// ready, and startup then creates the one owner window. Every terminal exit ends
// owned subprocesses, including standalone version reads outside operation
// shutdown, while an independently launched player keeps running.

const appHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const windows = vi.hoisted(() => [] as Array<{ focus: ReturnType<typeof vi.fn> }>)
// Each handler or window the entry adds wakes the waiters, which check again.
const waiters = vi.hoisted(() => [] as Array<() => void>)
const changed = vi.hoisted(() => () => { for (const wake of waiters.splice(0)) wake() })
const order = vi.hoisted(() => [] as string[])
const language = vi.hoisted(() => ({ release: (() => {}) as () => void }))
const versionFixture = vi.hoisted(() => ({ script: '' }))
const exitCalled = vi.hoisted(() => ({ resolve: () => {} }))

vi.mock('electron', () => {
  class BrowserWindow {
    readonly webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() }
    readonly focus = vi.fn()
    constructor() {
      order.push('window')
      windows.push(this)
      changed()
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
      setPath: vi.fn(),
      on: (event: string, handler: (...args: unknown[]) => unknown) => { appHandlers.set(event, handler); changed() },
      whenReady: () => Promise.resolve(),
      quit: vi.fn(),
      exit: vi.fn(() => { order.push('app-exit'); exitCalled.resolve() }),
      isPackaged: false,
    },
    BrowserWindow,
    powerMonitor: { on: vi.fn() },
    shell: { openExternal: vi.fn() },
  }
})

const step = (name: string) => vi.fn(async () => { order.push(name) })
vi.mock('@main/paths', () => ({
  ensureDirs: vi.fn(async () => {}), sweepAbandonedStaging: vi.fn(async () => {}),
  binaryPath: () => process.execPath,
  paths: { electronProfile: '/data-root/electron' },
}))
vi.mock('@main/startup-dialog', () => ({ notifyCorruptConfig: vi.fn(), notifyCorruptSession: vi.fn(), notifyStartupFailure: vi.fn() }))
vi.mock('@main/io/logger', () => ({ initLogger: vi.fn(), isDebugEnabled: () => false, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/io/records', () => ({ flushRecords: vi.fn(async () => {}), closeRecords: vi.fn(async () => {}), flushRecordsBeforeExit: vi.fn(() => { order.push('records-drain') }), onRecordStored: vi.fn(), openRecords: () => 'session' }))
vi.mock('@main/records-window', () => ({ notifyRecordsChanged: vi.fn() }))
vi.mock('@main/store/config', () => ({ getSettings: () => ({ language: 'en', theme: 'system' }), loadSettings: vi.fn(async () => ({ status: 'loaded' })) }))
vi.mock('@main/store/dependencies', () => ({ loadDependencies: vi.fn(async () => {}) }))
vi.mock('@main/store/stored-names', () => ({ convertStoredNames: vi.fn(async () => {}) }))
vi.mock('@main/store/session', () => ({ loadSession: vi.fn(async () => { order.push('session'); return { status: 'loaded' } }), persistNow: vi.fn(async () => true) }))
vi.mock('@main/store/layout', () => ({ loadLayout: step('layout'), persistNow: vi.fn(async () => {}) }))
vi.mock('@main/ipc/index', () => ({ registerIpcHandlers: vi.fn(() => { order.push('ipc') }) }))
vi.mock('@main/ipc/binaries', () => ({ resumeBinaryOperations: vi.fn(), shutdownBinaryOperations: vi.fn(async () => {}) }))
vi.mock('@main/queue/manager', () => ({ start: vi.fn(() => { order.push('queue') }), shutdown: vi.fn(async () => {}), resumeAfterQuit: vi.fn(), hasActiveJobs: () => false }))
vi.mock('@main/binaries/manager', () => ({ hasInstalls: () => false }))
vi.mock('@main/ipc/scan', () => ({ cancelAllScans: vi.fn(async () => {}), resumeScans: vi.fn(), hasActiveScans: () => false }))
vi.mock('@main/work-registry', () => ({ cancelAllWork: vi.fn(async () => {}), resumeWork: vi.fn(), hasRunningWork: () => false }))
vi.mock('@main/media-server', () => ({ startMediaServer: step('media'), stopMediaServer: vi.fn(async () => {}) }))
vi.mock('@main/power-blocker', () => ({ releaseWakeLock: vi.fn() }))
vi.mock('@main/window-options', () => ({ windowOptions: () => ({}) }))
vi.mock('@main/theme', () => ({ applyThemePreference: vi.fn(), followOsThemeChanges: vi.fn(), windowBackground: () => '#000' }))
vi.mock('@main/window-state-recovery', () => ({ createWindowWithUsablePersistedBounds: (_key: string, make: () => unknown) => make() }))
vi.mock('@main/window-minimum', () => ({ configureWindowMinimum: vi.fn() }))
vi.mock('@main/window-activity', () => ({ configureWindowActivity: vi.fn() }))
vi.mock('@main/window-close', () => ({ configureWindowClose: vi.fn(), registerDraftAnswers: vi.fn(), settleWindowDrafts: vi.fn(async () => true) }))
vi.mock('@main/store/backupStore', () => ({ closeBackupStore: vi.fn(async () => {}) }))
vi.mock('@main/plain-message-dialog', () => ({ showPlainMessageDialog: vi.fn() }))
vi.mock('@main/force-exit', () => ({ forceExitProcess: vi.fn(() => { order.push('force-exit') }) }))
vi.mock('@main/io/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/spawn')>()
  return {
    ...actual,
    killOwnedProcessesNow: vi.fn(() => { order.push('kill-tools'); actual.killOwnedProcessesNow() }),
  }
})
vi.mock('@main/binaries/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/binaries/registry')>()
  return {
    ...actual,
    binarySpecs: {
      ...actual.binarySpecs,
      'yt-dlp': {
        ...actual.binarySpecs['yt-dlp'],
        // Only the executable and its arguments are fixtures. The version read,
        // capture, ownership set, process kill and quit wiring stay real.
        installedVersion: {
          kind: 'probe',
          get args() { return [versionFixture.script] },
          parse: actual.parseYtDlpVersion,
        },
      },
    },
  }
})
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

/** Resolves once `check` holds, checking it first and again after each change. */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise<void>((resolve) => waiters.push(resolve))
}

function waitingFixture(directory: string, name: string) {
  const script = join(directory, `${name}.cjs`)
  const ready = join(directory, `${name}-ready.txt`)
  const release = join(directory, `${name}-release.txt`)
  const pulse = join(directory, `${name}-pulse.txt`)
  const gone = join(directory, `${name}-gone.txt`)
  writeFileSync(script,
    `const fs = require('node:fs');\n` +
    `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));\n` +
    `let pulse = 0; setInterval(() => {\n` +
    `  if (fs.existsSync(${JSON.stringify(release)})) { fs.writeFileSync(${JSON.stringify(gone)}, ''); process.exit(0); }\n` +
    `  fs.writeFileSync(${JSON.stringify(pulse)}, String(++pulse));\n` +
    `}, 25);\n`,
  )
  return { script, ready, release, pulse, gone }
}

describe('the Electron entry', () => {
  it('creates no window for a second launch or activation during the language load, then exactly one', async () => {
    await until(() => appHandlers.has('activate'))
    appHandlers.get('second-instance')!()
    appHandlers.get('activate')!()
    expect(windows).toHaveLength(0)

    language.release()
    await until(() => windows.length === 1)
    expect(order.slice(0, order.indexOf('window'))).toEqual(expect.arrayContaining(['session', 'layout', 'media', 'ipc', 'queue']))

    appHandlers.get('second-instance')!()
    expect(windows).toHaveLength(1)
    expect(windows[0]!.focus).toHaveBeenCalledOnce()
  })

  it('ends a standalone version probe on ordinary quit while the independent player keeps running', async ({ signal }) => {
    const directory = mkdtempSync(join(tmpdir(), 'tapebox-quit-processes-'))
    const version = waitingFixture(directory, 'version')
    const player = waitingFixture(directory, 'player')
    let readingVersion: Promise<string | null> | null = null
    let playerStarted = false
    let versionPid = 0
    let playerPid = 0
    try {
      forgetInstalledVersion('yt-dlp')
      versionFixture.script = version.script
      readingVersion = readInstalledVersion('yt-dlp')
      versionPid = await waitForFixture(directory, () => {
        const pid = Number(readFileSync(version.ready, 'utf8'))
        return pid > 0 ? pid : undefined
      }, signal)

      // Exercise the actual direct-executable handoff on every host. No OS
      // browser, native application or media file is needed for this control.
      playerStarted = true
      await openExternalPlayer(process.execPath, player.script, 'linux')
      playerPid = await waitForFixture(directory, () => {
        const pid = Number(readFileSync(player.ready, 'utf8'))
        return pid > 0 ? pid : undefined
      }, signal)
      // The player's first pulse, so its liveness below compares two real pulses.
      await waitForFixture(directory, () => Number(readFileSync(player.pulse, 'utf8')) > 0 ? true : undefined, signal)
      expect(() => process.kill(versionPid, 0)).not.toThrow()
      expect(() => process.kill(playerPid, 0)).not.toThrow()
      order.length = 0

      // Settle on the quit's own exit and the probe's own close rather than on
      // wall-clock polls, which a loaded machine can outlast.
      const exited = new Promise<void>((resolve) => { exitCalled.resolve = resolve })
      const event = { preventDefault: vi.fn() }
      appHandlers.get('before-quit')!(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      await exited
      expect(app.exit).toHaveBeenCalledExactlyOnceWith(0)
      expect(order.slice(-2)).toEqual(['kill-tools', 'app-exit'])
      // Observe the real process, not just an invocation of the sweep. The
      // ordinary exit previously left this signal-less probe running for 30 s.
      // The probe's read settles once the process has closed and been reaped.
      expect(await readingVersion).toBeNull()
      expect(() => process.kill(versionPid, 0)).toThrow()

      const before = Number(readFileSync(player.pulse, 'utf8'))
      await waitForFixture(directory, () => Number(readFileSync(player.pulse, 'utf8')) > before ? true : undefined, signal)
      expect(() => process.kill(playerPid, 0)).not.toThrow()
    } finally {
      // The release marker also handles failure before the player reports its
      // PID: whenever its script starts, it exits without relying on the test
      // having captured the handoff's unreferenced ChildProcess.
      if (playerStarted) writeFileSync(player.release, '')
      killOwnedProcessesNow()
      try {
        await readingVersion
        // The player reports leaving as its last act before it exits.
        if (playerStarted) await waitForFixture(directory, () => existsSync(player.gone) || undefined, signal)
      } finally {
        forgetInstalledVersion('yt-dlp')
        versionFixture.script = ''
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })

  it('lands the fatal record, then kills the download tools before a forced exit', () => {
    order.length = 0
    const uncaught = processHandlers.find(([event]) => event === 'uncaughtException')![1]
    uncaught(new Error('fatal'))
    expect(order).toEqual(['records-drain', 'kill-tools', 'force-exit'])
    expect(processHandlers.map(([event]) => event), 'no exit hook: every way out closes the records itself').not.toContain('exit')
  })
})
