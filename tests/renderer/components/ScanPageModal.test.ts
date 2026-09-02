// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScanResult } from '@shared/ipc-contract'

// The modal's IPC surface is mocked so a scan can be driven to a selectable entry
// and the bulk-add then made to fail/succeed deterministically. ipcOn listeners
// are captured per channel in a Set, and off() removes only the specific listener
// — mirroring ipcRenderer.on so the mock can't paper over a subscribe/cleanup bug.
const { ipcInvoke, listeners } = vi.hoisted(() => ({
  ipcInvoke: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}))

function emitEvent(channel: string, payload: unknown): void {
  for (const fn of listeners.get(channel) ?? []) fn(payload)
}

vi.mock('@renderer/ipc/client', () => ({
  ipcInvoke,
  ipcOn: (channel: string, listener: (payload: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set()
    set.add(listener)
    listeners.set(channel, set)
    return () => {
      listeners.get(channel)?.delete(listener)
    }
  },
}))
vi.mock('@renderer/ipc/log', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { ScanPageModal } from '@renderer/components/ScanPageModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  listeners.clear()
  ipcInvoke.mockReset()
  // Default: any call without an explicit per-call result resolves, so the
  // unmount-time scan:cancel has a real promise to .catch on.
  ipcInvoke.mockResolvedValue(undefined)
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

const ENTRY: ScanResult = {
  sourceId: 'v1',
  sourceUrl: 'https://example.test/watch?v=1',
  title: 'A video',
  durationSeconds: 12,
  uploadDateUtc: null,
  thumbnailUrl: null,
  alreadyInLibrary: false,
  unavailable: null,
}

async function mount(onClose: () => void): Promise<void> {
  root = createRoot(container)
  await act(async () => {
    root!.render(
      React.createElement(ScanPageModal, { onClose, initialUrl: 'https://example.test/list' }),
    )
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
  if (!(btn instanceof HTMLButtonElement)) throw new Error(`button "${text}" not found`)
  return btn
}

/** Let floating async handlers (a void confirm()/scan()) settle inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Scan, then deliver one auto-selected entry so the Add button has a selection. */
async function scanOneEntry(): Promise<void> {
  ipcInvoke.mockResolvedValueOnce({ sessionId: 'S1' }) // scan:start
  await act(async () => {
    buttonByText('Scan').click()
  })
  await flush()
  await act(async () => {
    emitEvent('scan:entry', { sessionId: 'S1', entry: ENTRY })
  })
}

describe('ScanPageModal bulk add', () => {
  it('keeps an inline alert and retry state in the modal when addBulk fails', async () => {
    const onClose = vi.fn()
    await mount(onClose)
    await scanOneEntry()

    ipcInvoke.mockRejectedValueOnce(new Error('EACCES /private/tmp/TAPEBOX_SCAN_SENTINEL')) // downloads:addBulk
    await act(async () => {
      buttonByText('Add 1 tape').click()
    })
    await flush()

    expect(onClose).not.toHaveBeenCalled()
    const alert = document.querySelector('[role="dialog"] [role="alert"]')
    expect(alert?.textContent).toContain(
      'The selected tapes could not be added. The library is unchanged; try again.',
    )
    expect(alert?.textContent).not.toMatch(/EACCES|private\/tmp|TAPEBOX_SCAN_SENTINEL/)
    // Not stuck on "Adding…": the button is interactive again for a retry.
    expect(buttonByText('Add 1 tape')).toBeTruthy()
  })

  it('closes without an error result when addBulk succeeds', async () => {
    const onClose = vi.fn()
    await mount(onClose)
    await scanOneEntry()

    ipcInvoke.mockResolvedValueOnce([]) // downloads:addBulk
    await act(async () => {
      buttonByText('Add 1 tape').click()
    })
    await flush()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})
