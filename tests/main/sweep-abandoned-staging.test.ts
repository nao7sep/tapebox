import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// sweepAbandonedStaging removes crash-left download staging from ~/.tapebox/temp
// on launch, but only once ownership is proven (managed-runtime-dependencies-
// conventions): a staged name carries the host tag and pid of the process that
// created it, and a file is only removed when it is tagged for THIS host and its
// process has exited, or it has outlived the whole acquisition's own deadline. It
// must run against a redirected storage root, never the real one — so
// TAPEBOX_DATA_DIR is pointed at a scratch dir BEFORE @main/paths is first imported
// (its storageRoot() caches on first access).
describe('sweepAbandonedStaging', () => {
  const root = mkdtempSync(join(tmpdir(), 'tapebox-reset-'))
  const previous = process.env.TAPEBOX_DATA_DIR
  let paths: (typeof import('@main/paths'))['paths']
  let hostTag: (typeof import('@main/paths'))['hostTag']
  let sweepAbandonedStaging: (typeof import('@main/paths'))['sweepAbandonedStaging']

  beforeAll(async () => {
    process.env.TAPEBOX_DATA_DIR = root
    const mod = await import('@main/paths')
    paths = mod.paths
    hostTag = mod.hostTag
    sweepAbandonedStaging = mod.sweepAbandonedStaging
  })

  afterAll(() => {
    if (previous === undefined) delete process.env.TAPEBOX_DATA_DIR
    else process.env.TAPEBOX_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })

  it('stays inside the redirected storage root', () => {
    expect(paths.temp).toBe(join(root, 'temp'))
  })

  it('creates temp/ when it does not yet exist', async () => {
    rmSync(paths.temp, { recursive: true, force: true })
    await sweepAbandonedStaging(30 * 60_000)
    expect(existsSync(paths.temp)).toBe(true)
    expect(readdirSync(paths.temp)).toEqual([])
  })

  it('removes this host\'s staged file whose process has exited, keeps a live one, ' +
    'leaves another host\'s file and unrelated files alone', async () => {
    mkdirSync(paths.temp, { recursive: true })
    const tag = hostTag()
    // macOS caps pids below 100000 and Linux below 2^22, so this pid never runs.
    const deadPidHere = 'yt-dlp-' + tag + '-99999999-abcDEF12345.partial'
    const alivePidHere = 'yt-dlp-' + tag + '-' + process.pid + '-abcDEF12346.partial'
    // A dead-here pid tagged for a different host: TAPEBOX_DATA_DIR can point several
    // hosts at the same shared directory, and this host's pid table says nothing
    // about whether that other host's download is still running, so it must
    // survive the sweep untouched.
    const otherHostDeadPid = 'yt-dlp-deadbeef-99999999-abcDEF12347.partial'
    const unrelated = 'notes.txt'
    for (const name of [deadPidHere, alivePidHere, otherHostDeadPid, unrelated]) {
      writeFileSync(join(paths.temp, name), 'stale bytes')
    }

    await sweepAbandonedStaging(30 * 60_000)

    expect(readdirSync(paths.temp).sort()).toEqual([alivePidHere, otherHostDeadPid, unrelated].sort())
  })

  it('removes this host\'s staged file past the operation deadline even though its pid is alive', async () => {
    rmSync(paths.temp, { recursive: true, force: true })
    mkdirSync(paths.temp, { recursive: true })
    const tag = hostTag()
    const name = 'yt-dlp-' + tag + '-' + process.pid + '-abcDEF12348.partial'
    const filePath = join(paths.temp, name)
    writeFileSync(filePath, 'stale bytes')
    // Back-date the file well past a tiny deadline: a bounded operation cannot
    // still be legitimately in flight once it has outlived its own timeout,
    // whatever its recorded pid reports.
    const old = new Date(Date.now() - 60_000)
    utimesSync(filePath, old, old)

    await sweepAbandonedStaging(1_000)

    expect(readdirSync(paths.temp)).toEqual([])
  })
})
