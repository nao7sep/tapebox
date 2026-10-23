import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startLauncherControl } from '@main/launcher-control'

it('registers only a launcher-spawned app and routes authenticated requests through ordinary Quit', async () => {
  const quit = vi.fn()
  expect(await startLauncherControl(quit, {})).toBeUndefined()
  const root = await mkdtemp(join(tmpdir(), 'tapebox-launch-control-'))
  const path = join(root, 'ready.json')
  const close = await startLauncherControl(quit, { TAPEBOX_LAUNCHER_READY: path, TAPEBOX_LAUNCHER_TOKEN: 'private-token' })
  try {
    const ready = JSON.parse(await readFile(path, 'utf8'))
    expect(ready).toMatchObject({ token: 'private-token', pid: process.pid })
    const url = `http://127.0.0.1:${ready.port}/quit`
    expect((await fetch(url, { method: 'POST' })).status).toBe(403)
    expect(quit).not.toHaveBeenCalled()
    expect((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer private-token' } })).status).toBe(202)
    await new Promise((done) => setImmediate(done))
    expect(quit).toHaveBeenCalledOnce()
  } finally { await close!(); await rm(root, { recursive: true, force: true }) }
})
