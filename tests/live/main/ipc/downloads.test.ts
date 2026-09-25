// The download path end to end, driven through the real IPC handlers the
// renderer calls, with nothing substituted but Electron's window glue: the
// managed yt-dlp, ffmpeg, and deno, acquired through the app's own binaries
// handlers, and the real OpenAI API. Run only by npm run test:full, through
// vitest.live.config.ts.
//
// The binaries are acquired into a cache that persists between runs and follow
// the app's own rule: install what is missing, and update only what its upstream
// check reports newer. Each test starts the app on its own throwaway home, where
// the cached binaries are hard-linked, and downloads a corpus video from a
// loopback server that the test closes before it ends.

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { BinaryCheckResult, BinaryStatus } from '@shared/ipc-contract'
import type { Tape } from '@shared/domain'
import { deriveStatus } from '@shared/binary-status'

const handlers = vi.hoisted(() => new Map<string, (req: unknown) => Promise<unknown>>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req) => fn({}, req))
    },
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  app: { getVersion: () => '0.0.0-live', getPath: () => '/tmp', isPackaged: false, on: () => {} },
  shell: {},
  dialog: {},
  nativeTheme: { on: () => {}, themeSource: 'system', shouldUseDarkColors: false },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
}))

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const CACHE = join(REPO, 'node_modules', '.cache', 'tapebox-live')
const TOOL_HOME = join(CACHE, 'tools')
const CORPUS = join(REPO, '..', 'company', 'assets', 'test-fixtures')
const VIDEO = 'video/codecs/h264-aac-1s.mp4'
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

type App = Awaited<ReturnType<typeof startApp>>

/** Starts the main process on `home` the way src/main/index.ts does, minus the window. */
async function startApp(home: string) {
  process.env.TAPEBOX_HOME = home
  vi.resetModules()
  handlers.clear()
  const { ensureDirs, resetTempDir } = await import('@main/paths')
  const { initLogger, closeLogger } = await import('@main/io/logger')
  const { loadSettings } = await import('@main/store/config')
  const { loadDependencies } = await import('@main/store/dependencies')
  const session = await import('@main/store/session')
  const layout = await import('@main/store/layout')
  const { startMediaServer, stopMediaServer } = await import('@main/media-server')
  const { registerIpcHandlers } = await import('@main/ipc/index')
  const { shutdownBinaryOperations } = await import('@main/ipc/binaries')
  const queue = await import('@main/queue/manager')
  const { closeBackupStore } = await import('@main/store/backupStore')

  await ensureDirs()
  initLogger({ debug: false })
  await resetTempDir()
  await loadSettings()
  await loadDependencies()
  await session.loadSession()
  await layout.loadLayout()
  await startMediaServer()
  registerIpcHandlers()
  queue.start()

  return {
    session,
    invoke: <T>(channel: string, req?: unknown): Promise<T> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No IPC handler for ${channel}`)
      return handler(req) as Promise<T>
    },
    /** src/main/index.ts's shutdown, in its order. */
    shutdown: async () => {
      await shutdownBinaryOperations()
      await session.persistNow()
      await layout.persistNow()
      await stopMediaServer()
      await closeBackupStore()
      closeLogger()
    },
  }
}

/** Runs `body` against the app on `home`, then shuts it down and proves nothing it started remains. */
async function withApp<T>(home: string, body: (app: App) => Promise<T>): Promise<T> {
  const app = await startApp(home)
  let result: T
  try {
    result = await body(app)
  } finally {
    await app.shutdown()
  }
  const open = await openAfterClosing()
  expect(open, 'no child process outlives the app').not.toContain('ProcessWrap')
  expect(open, 'no server outlives the app').not.toContain('TCPServerWrap')
  return result
}

/**
 * The process's open resources once pending closes finish: a closed server or
 * exited child releases its handle a turn of the event loop after its close
 * callback, so a handle still open after two seconds really outlived its owner.
 */
async function openAfterClosing(): Promise<string[]> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const open = process.getActiveResourcesInfo()
    const settled = !open.includes('ProcessWrap') && !open.includes('TCPServerWrap')
    if (settled || Date.now() > deadline) return open
    await delay(20)
  }
}

/** A throwaway home whose managed binaries are the cached ones. */
async function freshHome(label: string): Promise<string> {
  const home = await mkdtemp(join(CACHE, `${label}-`))
  await linkTree(join(TOOL_HOME, 'bin'), join(home, 'bin'))
  return home
}

async function linkTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await linkTree(join(from, entry.name), join(to, entry.name))
    else if (entry.isFile()) await link(join(from, entry.name), join(to, entry.name))
  }
}

/** Serves one file over loopback HTTP, with byte ranges, until close() settles. */
async function serveFile(file: string): Promise<{ url: string; close: () => Promise<void> }> {
  const size = (await stat(file)).size
  const name = basename(file)
  const server = createServer((request, response) => {
    if (request.url !== `/${name}`) {
      response.writeHead(404).end()
      return
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    })
    if (request.method === 'HEAD') response.end()
    else createReadStream(file, { start, end }).pipe(response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/${name}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

/** Adds the corpus video through downloads:add and waits for its job to settle. */
async function downloadCorpusVideo(app: App, home: string): Promise<Tape> {
  const source = join(home, 'source', basename(VIDEO))
  await mkdir(join(home, 'source'), { recursive: true })
  await copyFile(join(CORPUS, VIDEO), source).catch(() => {
    throw new Error(
      `The live lane reads the shared test-fixture corpus at ${CORPUS}; check out the company repository beside this one.`,
    )
  })
  const server = await serveFile(source)
  try {
    const [added] = await app.invoke<Tape[]>('downloads:add', { url: server.url })
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS
    for (;;) {
      const tape = app.session.getTape(added!.id)!
      if (tape.state === 'downloaded' || tape.state === 'failed') return tape
      if (Date.now() > deadline) {
        await app.invoke('downloads:cancel', { tapeId: tape.id })
        throw new Error(`The tape was still ${tape.state} after ${DOWNLOAD_TIMEOUT_MS} ms.`)
      }
      await delay(250)
    }
  } finally {
    await server.close()
  }
}

let checkFailures: BinaryCheckResult | null = null

beforeAll(async () => {
  await mkdir(TOOL_HOME, { recursive: true })
  await withApp(TOOL_HOME, async (app) => {
    const update = async (name: BinaryStatus['name']) => {
      const result = await app.invoke<{ outcome: string; error?: string }>('binaries:update', {
        name,
        operationId: randomUUID(),
      })
      if (result.outcome !== 'installed') throw new Error(`Installing ${name} ended ${result.outcome}: ${result.error}`)
    }
    for (const status of await app.invoke<BinaryStatus[]>('binaries:status')) {
      if (!status.present) await update(status.name)
    }
    const check = await app.invoke<BinaryCheckResult>('binaries:checkUpdates')
    if (check.outcome !== 'completed' || check.failures.length > 0) checkFailures = check
    for (const status of await app.invoke<BinaryStatus[]>('binaries:status')) {
      if (facts(status).state === 'update-available') await update(status.name)
    }
  })
})

function facts(status: BinaryStatus) {
  return deriveStatus({
    present: status.present,
    installedVersion: status.installedVersion,
    desiredVersion: status.latestKnownVersion,
    lastCheckedAtUtc: status.lastCheckedAtUtc,
  })
}

describe('the live download path', () => {
  it('has its managed binaries installed, verified, and current', async () => {
    expect(checkFailures, 'the upstream update check must succeed').toBeNull()
    await withApp(TOOL_HOME, async (app) => {
      for (const status of await app.invoke<BinaryStatus[]>('binaries:status')) {
        expect(status.installedVersion, `${status.name} reports its version`).not.toBeNull()
        expect(facts(status).state, status.name).toBe('up-to-date')
      }
    })
  })

  it('downloads a corpus video through yt-dlp and records its probed media facts', async () => {
    const home = await freshHome('download')
    try {
      await withApp(home, async (app) => {
        const tape = await downloadCorpusVideo(app, home)
        expect(tape.lastError).toBeNull()
        expect(tape.state).toBe('downloaded')

        const library = join(home, 'library')
        expect((await stat(join(library, tape.filename!))).size).toBe((await stat(join(CORPUS, VIDEO))).size)
        const sidecar = JSON.parse(await readFile(join(library, tape.sidecarFilename!), 'utf8')) as {
          tapebox: { media: { width: number; height: number; vcodec: string; acodec: string; durationSeconds: number } }
        }
        expect(sidecar.tapebox.media).toMatchObject({ width: 480, height: 320, vcodec: 'h264', acodec: 'aac' })
        expect(Math.abs(sidecar.tapebox.media.durationSeconds - 1)).toBeLessThan(0.1)
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('suggests a file name for a downloaded tape through the real OpenAI API', async () => {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error('OPENAI_API_KEY is not set. The full run calls the real OpenAI API; export OPENAI_API_KEY and run it again.')
    }
    const { slugifyAscii } = await import('@main/core/slug')
    const home = await freshHome('slug')
    try {
      await withApp(home, async (app) => {
        const tape = await downloadCorpusVideo(app, home)
        expect(tape.state).toBe('downloaded')
        const { slug } = await app.invoke<{ slug: string }>('ai:generateSlug', {
          tapeId: tape.id,
          include: { title: true, uploader: true, description: true },
          requestId: 'live-slug',
        })
        expect(slug.length).toBeGreaterThan(0)
        expect(slug).toBe(slugifyAscii(slug))
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
