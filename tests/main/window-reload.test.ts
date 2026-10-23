import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createWindowReload } from '@main/window-reload'

function fixture() {
  const reload = vi.fn()
  const reloadIgnoringCache = vi.fn()
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, reload, reloadIgnoringCache } } as unknown as BrowserWindow
  let answer!: (allow: boolean) => void
  const confirm = vi.fn((_window: BrowserWindow, _signal: AbortSignal) => new Promise<boolean>((resolve) => { answer = resolve }))
  const failed = vi.fn()
  const owner = createWindowReload(confirm, failed)
  return { owner, window, confirm, failed, reload, reloadIgnoringCache, answer: (allow: boolean) => answer(allow) }
}

it.each([false, true])('reloads only after discard consent (force: %s)', async (force) => {
  const f = fixture()
  const request = f.owner.request(f.window, force)
  await f.owner.request(f.window, force)
  expect(f.confirm).toHaveBeenCalledOnce()
  expect(f.reload).not.toHaveBeenCalled()
  expect(f.reloadIgnoringCache).not.toHaveBeenCalled()
  f.answer(true)
  await request
  expect(force ? f.reloadIgnoringCache : f.reload).toHaveBeenCalledOnce()
  expect(force ? f.reload : f.reloadIgnoringCache).not.toHaveBeenCalled()
})

it('leaves the page intact when the user keeps editing', async () => {
  const f = fixture()
  const request = f.owner.request(f.window, false)
  f.answer(false)
  await request
  expect(f.reload).not.toHaveBeenCalled()
})

it('ignores a late answer after quit takes over, even if that quit is cancelled', async () => {
  const f = fixture()
  const request = f.owner.request(f.window, false)
  const signal = f.confirm.mock.calls[0]![1]
  f.owner.beginQuit()
  expect(signal.aborted).toBe(true)
  await f.owner.request(f.window, true)
  expect(f.confirm).toHaveBeenCalledOnce()
  f.owner.resume()
  f.answer(true)
  await request
  expect(f.reload).not.toHaveBeenCalled()
  const next = f.owner.request(f.window, true)
  f.answer(true)
  await next
  expect(f.reloadIgnoringCache).toHaveBeenCalledOnce()
})

it('keeps the page when consent fails or its window disappears', async () => {
  const f = fixture()
  f.confirm.mockRejectedValueOnce(new Error('dialog unavailable'))
  await f.owner.request(f.window, false)
  expect(f.failed).toHaveBeenCalledOnce()
  expect(f.reload).not.toHaveBeenCalled()
  const next = f.owner.request(f.window, false)
  f.window.isDestroyed = () => true
  f.answer(true)
  await next
  expect(f.reload).not.toHaveBeenCalled()
})
