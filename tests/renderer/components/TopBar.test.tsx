// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))

import { TopBar } from '@renderer/components/TopBar'
import { useBinariesStore } from '@renderer/store/binaries'
import type { BinaryStatus } from '@shared/ipc-contract'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement

function ready(name: BinaryStatus['name']): BinaryStatus {
  return {
    name,
    present: true,
    installedVersion: '1.0.0',
    latestKnownVersion: '1.0.0',
    lastCheckedAtUtc: '2026-09-02T00:00:00.000Z',
  }
}

beforeEach(async () => {
  vi.useFakeTimers()
  ipcInvoke.mockReset()
  useBinariesStore.setState({ statuses: [ready('yt-dlp'), ready('ffmpeg')] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(TopBar, { clipboardEnabled: false })))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

async function enter(value: string): Promise<HTMLInputElement> {
  const input = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

async function add(): Promise<void> {
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
}

describe('TopBar Add URL result ownership', () => {
  it('retains a failed value and associates the local alert with its input', async () => {
    ipcInvoke.mockRejectedValueOnce(new Error('Library is read-only'))
    const input = await enter('https://example.test/watch')
    await add()

    const alert = host.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain('Library is read-only')
    expect(input.value).toBe('https://example.test/watch')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(alert.id)
  })

  it('clears the matching failure on edit, dismissal, and successful retry', async () => {
    ipcInvoke.mockRejectedValueOnce(new Error('First failure'))
    await enter('https://example.test/first')
    await add()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()

    await enter('https://example.test/second')
    expect(host.querySelector('[role="alert"]')).toBeNull()

    ipcInvoke.mockRejectedValueOnce(new Error('Second failure'))
    await add()
    const dismiss = host.querySelector<HTMLButtonElement>('[aria-label="Dismiss Add URL error"]')!
    await act(async () => dismiss.click())
    expect(host.querySelector('[role="alert"]')).toBeNull()

    ipcInvoke.mockRejectedValueOnce(new Error('Retry failure')).mockResolvedValueOnce([])
    await enter('https://example.test/retry')
    await add()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    await add()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('')
  })
})
