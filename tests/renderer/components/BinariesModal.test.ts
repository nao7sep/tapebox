// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BinaryStatus } from '@shared/ipc-contract'
import { useBinariesStore } from '@renderer/store/binaries'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))

import { BinariesModal } from '@renderer/components/BinariesModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement

function status(over: Partial<BinaryStatus> = {}): BinaryStatus {
  return {
    name: 'yt-dlp',
    present: false,
    installedVersion: null,
    latestKnownVersion: null,
    lastCheckedAtUtc: null,
    ...over,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  ipcInvoke.mockReset()
  useBinariesStore.setState({
    statuses: [status()],
    progress: {},
    modalOpen: true,
    checking: false,
    checkFailures: null,
  })
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

async function mount(): Promise<void> {
  root = createRoot(container)
  await act(async () => root!.render(React.createElement(BinariesModal)))
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!(match instanceof HTMLButtonElement)) throw new Error(`button "${text}" not found`)
  return match
}

describe('BinariesModal check and acquisition outcomes', () => {
  it('shows failures retained from the launch check', async () => {
    useBinariesStore.setState({
      checkFailures: [{ name: 'ffmpeg', message: 'release host offline' }],
    })
    await mount()

    expect(document.body.textContent).toContain('Check incomplete — ffmpeg failed.')
    expect(document.body.textContent).toContain('ffmpeg: release host offline')
  })

  it('shows a TimeoutError instead of mistaking its aborted wording for Cancel', async () => {
    ipcInvoke.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )
    await mount()

    await act(async () => button('Install').click())

    expect(document.body.textContent).toContain('The operation was aborted due to timeout')
  })

  it('lets the user cancel an in-progress update check', async () => {
    useBinariesStore.setState({ checking: true })
    ipcInvoke.mockResolvedValueOnce({ outcome: 'cancel-requested' })
    await mount()

    await act(async () => button('Cancel check').click())

    expect(ipcInvoke).toHaveBeenCalledWith('binaries:cancelCheck')
  })
})
