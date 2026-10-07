import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
// Every path that copies a file onto another volume, driven through the real IPC
// handlers onto a real exFAT disk image: import from it, export to it, move the
// library onto it, and import into the library that now lives there. exFAT has no
// hard links, so each file goes through the copy into an exclusive claim, and its
// file ids change once bytes are written. Run only by npm run test:full, through
// vitest.live.config.ts, on macOS, where hdiutil makes the image.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { FORMAT_VERSIONS } from '@main/io/format-version'
import type { ImportResult, IpcCalls } from '@shared/ipc-contract'

const run = promisify(execFile)
const HDIUTIL_TIMEOUT_MS = 60_000
const MEDIA_BYTES = 600_000 // more than two copy chunks
const MODIFIED = new Date('2021-04-05T06:07:08.000Z')

const handlers = vi.hoisted(() => new Map<string, (req: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  // A settings save re-applies the language, which rebuilds the native menu.
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  app: { getVersion: () => '0.0.0-live', getPath: () => '/tmp', isPackaged: false, on: () => {} },
  shell: {},
  dialog: {},
  nativeTheme: { on: () => {}, themeSource: 'system', shouldUseDarkColors: false },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
}))

function invoke<C extends keyof IpcCalls>(channel: C, req: IpcCalls[C]['req']): Promise<IpcCalls[C]['res']> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No IPC handler for ${channel}`)
  return handler(req) as Promise<IpcCalls[C]['res']>
}

/** Starts the main process on `home` the way src/main/index.ts does, minus the
 * window, the download queue and the media server, which no copy touches. */
async function startApp(home: string) {
  process.env.TAPEBOX_DATA_DIR = home
  vi.resetModules()
  handlers.clear()
  const { ensureDirs } = await import('@main/paths')
  const { openRecords, closeRecords } = await import('@main/io/records')
  const { loadSettings } = await import('@main/store/config')
  const { loadDependencies } = await import('@main/store/dependencies')
  const session = await import('@main/store/session')
  const layout = await import('@main/store/layout')
  const { registerIpcHandlers } = await import('@main/ipc/index')
  const { closeBackupStore } = await import('@main/store/backupStore')

  await ensureDirs()
  openRecords()
  await loadSettings()
  await loadDependencies()
  await session.loadSession()
  await layout.loadLayout()
  registerIpcHandlers()
  return async () => {
    await session.persistNow()
    await layout.persistNow()
    await closeBackupStore()
    await closeRecords()
  }
}

/** A downloaded tape's bundle as export writes it: media, poster and sidecar. */
async function writeBundle(dir: string, stem: string, sourceUrl: string): Promise<string[]> {
  await mkdir(dir, { recursive: true })
  const media = join(dir, `${stem}.mp4`)
  const poster = join(dir, `${stem}.jpg`)
  const sidecar = join(dir, `${stem}.json`)
  await writeFile(media, Buffer.alloc(MEDIA_BYTES, 0x5a))
  await writeFile(poster, Buffer.alloc(1_000, 0x11))
  await writeFile(sidecar, JSON.stringify({
    formatVersion: FORMAT_VERSIONS.sidecar,
    id: stem, extractor: 'generic', title: stem,
    tapebox: {
      sourceUrl, name: stem, addedAtUtc: '2021-04-05T00:00:00.000Z',
      downloadedAtUtc: '2021-04-05T00:00:00.000Z', renamedAtUtc: null, media: null,
      mediaFilename: `${stem}.mp4`, thumbnailFilename: `${stem}.jpg`,
    },
  }))
  await utimes(media, MODIFIED, MODIFIED)
  return [media, poster, sidecar]
}

/** Every name on the volume, kernel `._` companions aside. */
async function volumeNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true })
  return entries.filter((name) => !name.split('/').some((part) => part.startsWith('._'))).sort()
}

const isMac = process.platform === 'darwin'
let root: string
let volume: string

beforeAll(async () => {
  if (!isMac) return
  root = await mkdtemp(join(tmpdir(), 'tapebox-exfat-'))
  volume = join(root, 'volume')
  const image = join(root, 'exfat.dmg')
  await run('hdiutil', ['create', '-size', '64m', '-fs', 'ExFAT', '-volname', 'TAPEBOXLIVE', image], { timeout: HDIUTIL_TIMEOUT_MS })
  await run('hdiutil', ['attach', '-nobrowse', '-mountpoint', volume, image], { timeout: HDIUTIL_TIMEOUT_MS })
})

afterAll(async () => {
  if (!isMac) return
  await run('hdiutil', ['detach', '-force', volume], { timeout: HDIUTIL_TIMEOUT_MS }).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

describe('copies onto exFAT', () => {
  it('import, export, library move and import into the moved library each finish and leave no temp', async (ctx) => {
    ctx.skip(!isMac, 'macOS only: hdiutil makes the exFAT image')
    const home = join(root, 'home')
    const stop = await startApp(home)
    try {
      // Import from the exFAT volume into the library on the system volume.
      const first = await writeBundle(join(volume, 'incoming'), 'First', 'https://example.test/first')
      const imported = await invoke('library:import', { paths: first }) as ImportResult
      expect(imported.issues).toEqual([])
      const [tape] = imported.imported
      expect((await stat(join(home, 'library', 'First.mp4'))).mtimeMs).toBe(MODIFIED.getTime())

      // Export onto the exFAT volume.
      const outbox = join(volume, 'exported')
      await mkdir(outbox)
      await invoke('export:files', { tapeId: tape!.id, destinationDir: outbox, name: 'Holiday', deleteFromApp: false })
      expect(await readdir(outbox).then((names) => names.filter((n) => !n.startsWith('._')).sort()))
        .toEqual(['Holiday.jpg', 'Holiday.json', 'Holiday.mp4'])
      const exported = await stat(join(outbox, 'Holiday.mp4'))
      expect(exported.size).toBe(MEDIA_BYTES)
      expect(exported.mtimeMs).toBe(MODIFIED.getTime())

      // Move the library onto the exFAT volume.
      const library = join(volume, 'library')
      await invoke('settings:update', { libraryDir: library })
      expect(await readFile(join(library, 'First.mp4'))).toHaveLength(MEDIA_BYTES)
      expect((await stat(join(library, 'First.mp4'))).mtimeMs).toBe(MODIFIED.getTime())

      // Import from the system volume into the library that now lives on exFAT.
      const second = await writeBundle(join(root, 'incoming'), 'Second', 'https://example.test/second')
      const again = await invoke('library:import', { paths: second }) as ImportResult
      expect(again.issues).toEqual([])
      expect((await stat(join(library, 'Second.mp4'))).mtimeMs).toBe(MODIFIED.getTime())

      expect(await volumeNames(volume)).toEqual([
        'exported', 'exported/Holiday.jpg', 'exported/Holiday.json', 'exported/Holiday.mp4',
        'incoming', 'incoming/First.jpg', 'incoming/First.json', 'incoming/First.mp4',
        'library', 'library/First.jpg', 'library/First.json', 'library/First.mp4',
        'library/Second.jpg', 'library/Second.json', 'library/Second.mp4',
      ])
    } finally {
      await stop()
    }
  }, 120_000)
})
