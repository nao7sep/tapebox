// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClipboardUrl } from '@renderer/lib/useClipboardUrl'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
let state: ReturnType<typeof useClipboardUrl>
const readText = vi.fn<() => Promise<string>>()
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function Probe({ enabled = true, initial = '' }: { enabled?: boolean; initial?: string }) {
  state = useClipboardUrl(enabled, initial)
  return createElement('input', { value: state.url, readOnly: true })
}
async function render(enabled = true, initial = '') {
  if (!root) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root!.render(createElement(Probe, { enabled, initial })))
}
function deferred() {
  let resolve!: (text: string) => void
  const promise = new Promise<string>((yes) => { resolve = yes })
  return { promise, resolve }
}
async function advance() {
  await act(async () => vi.advanceTimersByTime(3000))
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.useFakeTimers()
  readText.mockReset().mockResolvedValue('')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

describe('clipboard URL lifetime and ownership', () => {
  it('reads immediately when enabled, skips user-owned fields, and resumes for an empty field', async () => {
    await render(true, 'https://example.test/seed')
    expect(readText).not.toHaveBeenCalled()
    await advance()
    expect(readText).not.toHaveBeenCalled()
    await act(async () => state.setUrl(''))
    readText.mockResolvedValue('https://example.test/clipboard')
    await advance()
    expect(state.url).toBe('https://example.test/clipboard')
    await act(async () => state.setUrl('https://example.test/typed'))
    readText.mockClear()
    await advance()
    expect(readText).not.toHaveBeenCalled()
    expect(state.url).toBe('https://example.test/typed')
  })

  it.each([true, false])('honors actual document focus when enabling (focused: %s)', async (focused) => {
    await render(false)
    vi.mocked(document.hasFocus).mockReturnValue(focused)
    readText.mockResolvedValue('https://example.test/current')
    await render(true)
    expect(readText).toHaveBeenCalledTimes(focused ? 1 : 0)
    if (!focused) {
      await advance()
      expect(readText).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      vi.mocked(document.hasFocus).mockReturnValue(true)
      await act(async () => window.dispatchEvent(new Event('focus')))
      expect(readText).toHaveBeenCalledOnce()
    }
    expect(state.url).toBe('https://example.test/current')
  })

  it('does not overwrite text typed while a read was pending', async () => {
    const pending = deferred()
    readText.mockReturnValueOnce(pending.promise)
    await render()
    await act(async () => state.setUrl('https://example.test/typed'))
    await act(async () => pending.resolve('https://example.test/clipboard'))
    expect(state.url).toBe('https://example.test/typed')
  })

  it('stops the interval on blur, rejects the old read, and reads again on focus', async () => {
    const pending = deferred()
    readText.mockReturnValueOnce(pending.promise)
    await render()
    await act(async () => window.dispatchEvent(new Event('blur')))
    await advance()
    expect(readText).toHaveBeenCalledTimes(1)
    readText.mockResolvedValue('https://example.test/new')
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(readText).toHaveBeenCalledTimes(2)
    expect(state.url).toBe('https://example.test/new')
    await act(async () => pending.resolve('https://example.test/old'))
    expect(state.url).toBe('https://example.test/new')
    await advance()
    expect(readText).toHaveBeenCalledTimes(3)
  })

  it('abandons a disabled generation and cleans up pending reads and listeners on unmount', async () => {
    const pending = deferred()
    readText.mockReturnValueOnce(pending.promise)
    await render()
    await render(false)
    await act(async () => pending.resolve('https://example.test/old'))
    expect(state.url).toBe('')
    await advance()
    expect(readText).toHaveBeenCalledTimes(1)
    const next = deferred()
    readText.mockReturnValueOnce(next.promise)
    await render(true)
    await act(async () => root!.unmount())
    root = null
    await act(async () => next.resolve('https://example.test/after-unmount'))
    await act(async () => window.dispatchEvent(new Event('focus')))
    await advance()
    expect(readText).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps at most one read pending in a focus generation', async () => {
    const pending = deferred()
    readText.mockReturnValueOnce(pending.promise)
    await render()
    await advance()
    expect(readText).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve('https://example.test/value'))
    expect(state.url).toBe('https://example.test/value')
  })
})
