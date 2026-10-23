import { mkdtemp, readFile, rm, writeFile, mkdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Directly executed launcher helpers intentionally have no declarations.
import { runtimeOwner, publishCandidate } from '../../scripts/launcher-runtime.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tapebox-launcher-'))
  roots.push(root)
  const identities = new Map<number, string>()
  let time = 0
  const close = vi.fn(async () => { identities.clear() })
  const owner = runtimeOwner({ recordPath: join(root, 'owner.json'), identity: async (pid: number) => identities.get(pid) ?? null,
    close, now: () => time, wait: async (ms: number) => { time += ms; await new Promise((done) => setImmediate(done)) }, timeout: 500 })
  const record = { token: 'old', root: { pid: 10, created: 'root-start' }, app: { pid: 11, created: 'app-start', port: 123 } }
  identities.set(10, 'root-start'); identities.set(11, 'app-start')
  await owner.save(record)
  return { root, owner, identities, close, record }
}

describe('recorded launcher ownership', () => {
  it('waits for both recorded processes before replacing a generation', async () => {
    const { owner, identities, close } = await fixture()
    close.mockImplementation(async () => { identities.delete(11) })
    const launch = vi.fn()
    await expect(owner.replace('new', launch)).rejects.toThrow('still running')
    expect(launch).not.toHaveBeenCalled()
    expect((await owner.read()).token).toBe('old')
    identities.delete(10)
    await owner.replace('new', launch)
    expect(launch).toHaveBeenCalledOnce()
  })

  it('still closes the recorded app after its toolchain parent disappears', async () => {
    const { owner, identities, close } = await fixture()
    identities.delete(10)
    await owner.stopIfOwner('old')
    expect(close).toHaveBeenCalledOnce()
    expect(await owner.read()).toBeNull()
  })

  it('never closes a reused PID or a stale generation, regardless of its executable', async () => {
    const { owner, identities, close } = await fixture()
    identities.set(10, 'unrelated-new-root'); identities.set(11, 'unrelated-new-app')
    await owner.replace('new', async () => {})
    expect(await owner.stopIfOwner('old')).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(identities.size).toBe(2)
  })

  it('uses the registered replacement Electron child after a development reload', async () => {
    const { root, owner, identities, close, record } = await fixture()
    const readyPath = join(root, 'ready')
    identities.delete(11)
    identities.set(12, 'new-app-start')
    await writeFile(readyPath, JSON.stringify({ token: 'old', pid: 12, port: 456 }))
    await owner.save({ ...record, readyPath })
    await owner.stopIfOwner('old')
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ app: { pid: 12, created: 'new-app-start', port: 456 } }))
  })

  it('refuses to infer that an unregistered child exited with its parent', async () => {
    const { owner, identities } = await fixture()
    identities.clear()
    await owner.save({ token: 'old', root: { pid: 10, created: 'root-start' }, app: null, launching: true })
    const launch = vi.fn()
    await expect(owner.replace('new', launch)).rejects.toThrow('never registered readiness')
    expect(launch).not.toHaveBeenCalled()
  })

  it('preserves the original close failure and never starts a replacement', async () => {
    const { owner, close } = await fixture()
    const failure = new Error('control access denied')
    close.mockRejectedValue(failure)
    const launch = vi.fn()
    await expect(owner.replace('new', launch)).rejects.toBe(failure)
    expect(launch).not.toHaveBeenCalled()
    expect((await owner.read()).token).toBe('old')
  })

  it('serializes a competing claim until launch readiness and makes stale cleanup harmless', async () => {
    const { owner, close } = await fixture()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((done) => { entered = done })
    const gate = new Promise<void>((done) => { release = done })
    const first = owner.replace('first', async () => { entered(); await gate })
    await started
    const secondLaunch = vi.fn(async () => {})
    const second = owner.replace('second', secondLaunch)
    await new Promise((done) => setImmediate(done))
    expect(secondLaunch).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second])
    expect(await owner.stopIfOwner('first')).toBe(false)
    expect((await owner.read()).token).toBe('second')
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the prior runnable package if candidate publication fails', async () => {
    const { root } = await fixture()
    const destination = join(root, 'dist'), candidate = join(root, 'candidate')
    await mkdir(destination); await mkdir(candidate)
    await writeFile(join(destination, 'app'), 'old')
    await writeFile(join(candidate, 'app'), 'new')
    await expect(publishCandidate(candidate, destination, 'test', async (from: string, to: string) => {
      if (from === candidate) throw new Error('candidate move failed')
      await rename(from, to)
    })).rejects.toThrow('candidate move failed')
    expect(await readFile(join(destination, 'app'), 'utf8')).toBe('old')
    expect(await readFile(join(candidate, 'app'), 'utf8')).toBe('new')
  })
})
