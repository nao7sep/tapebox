// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BinaryStatus } from '@shared/ipc-contract'
import { useBinariesStore } from '@renderer/store/binaries'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))

import { BinariesModal } from '@renderer/components/BinariesModal'
import { message } from '@shared/i18n/translate'

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
    active: {},
    errors: {},
    terminalOutcomes: {},
    statusRevisions: {},
    modalOpen: true,
    checking: false,
    checkCancelling: false,
    checkError: null,
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
  it('installs the missing required pair only after a click, with no duplicate attempts', async () => {
    useBinariesStore.setState({ statuses: [status(), status({ name: 'ffmpeg' }), status({ name: 'deno' })] })
    ipcInvoke.mockImplementation(() => new Promise(() => {}))
    await mount()
    expect(document.body.textContent).toContain('Downloads require yt-dlp and ffmpeg. Deno is optional.')
    expect(ipcInvoke).not.toHaveBeenCalled()
    await act(async () => button('Install yt-dlp and ffmpeg').click())
    expect(ipcInvoke.mock.calls.map((call) => call[1].name)).toEqual(['yt-dlp', 'ffmpeg'])
    expect(button('Install yt-dlp and ffmpeg').disabled).toBe(true)
    await act(async () => button('Install yt-dlp and ffmpeg').click())
    expect(ipcInvoke).toHaveBeenCalledTimes(2)
    expect(button('Install').disabled, 'Deno keeps its individual action').toBe(false)
  })

  it('keeps installed tools and retries only the missing tool after partial failure', async () => {
    useBinariesStore.setState({ statuses: [status(), status({ name: 'ffmpeg' }), status({ name: 'deno' })] })
    ipcInvoke.mockImplementation((_channel, request: { name: string; operationId: string }) => {
      if (request.name === 'ffmpeg') return Promise.reject(new Error('download failed'))
      return Promise.resolve({ outcome: 'installed', operationId: request.operationId, status: status({ present: true, installedVersion: '1' }) })
    })
    await mount()
    await act(async () => button('Install yt-dlp and ffmpeg').click())
    expect(document.body.textContent).toContain('ffmpeg could not be installed or updated.')
    ipcInvoke.mockClear()
    await act(async () => button('Install yt-dlp and ffmpeg').click())
    expect(ipcInvoke.mock.calls.map((call) => call[1].name)).toEqual(['ffmpeg'])
  })

  it('hides the combined action once both required tools are present', async () => {
    useBinariesStore.setState({ statuses: [status({ present: true }), status({ name: 'ffmpeg', present: true }), status({ name: 'deno' })] })
    await mount()
    expect(document.body.textContent).not.toContain('Install yt-dlp and ffmpeg')
    expect(button('Install').disabled).toBe(false)
  })

  it('immediately replaces Install from the authoritative terminal row', async () => {
    ipcInvoke.mockImplementationOnce((_channel, request: { operationId: string }) =>
      Promise.resolve({
        outcome: 'installed',
        operationId: request.operationId,
        status: status({
          present: true,
          installedVersion: '2026.09.01',
          latestKnownVersion: '2026.09.01',
        }),
      }),
    )
    await mount()

    await act(async () => button('Install').click())

    expect(document.body.textContent).toContain('2026.09.01')
    expect(Array.from(document.querySelectorAll('button')).some(
      (candidate) => candidate.textContent?.trim() === 'Install',
    )).toBe(false)
  })

  it('shows failures retained from the launch check', async () => {
    useBinariesStore.setState({
      checkFailures: [{ name: 'ffmpeg', message: message('tools.checkFailed', { tool: 'ffmpeg' }) }],
    })
    await mount()

    expect(document.body.textContent).toContain('Check incomplete — ffmpeg failed.')
    expect(document.body.textContent).toContain('ffmpeg: ffmpeg could not be checked.')
  })

  it('shows an authored failure instead of mistaking a TimeoutError for Cancel', async () => {
    ipcInvoke.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )
    await mount()

    await act(async () => button('Install').click())

    expect(document.body.textContent).toContain(
      'yt-dlp could not be installed or updated. The existing tool, if any, is unchanged; try again.',
    )
    expect(document.body.textContent).not.toContain('aborted due to timeout')
  })

  it('shows a retained cancellation beside the next valid action', async () => {
    useBinariesStore.setState({ terminalOutcomes: { 'yt-dlp': 'cancelled' } })
    await mount()

    expect(document.body.textContent).toContain('Cancelled')
    expect(button('Install').disabled).toBe(false)
  })

  it('lets the user cancel an in-progress update check', async () => {
    useBinariesStore.setState({ checking: true })
    ipcInvoke.mockResolvedValueOnce({ outcome: 'cancel-requested' })
    await mount()

    await act(async () => button('Cancel check').click())

    expect(ipcInvoke).toHaveBeenCalledWith('binaries:cancelCheck')
  })

  it('presents dependency states as user-facing labels', async () => {
    await mount()
    expect(document.body.textContent).toContain('Not installed')
    expect(document.body.textContent).toContain('Not checked')

    await act(async () => {
      useBinariesStore.setState({
        statuses: [status({ present: true, installedVersion: null })],
        checking: true,
      })
    })
    expect(document.body.textContent).toContain('Version unreadable')
    expect(document.body.textContent).toContain('Checking…')
  })

  it('shows a build tag as the build\'s date and time', async () => {
    useBinariesStore.setState({
      statuses: [status({
        name: 'ffmpeg',
        present: true,
        installedVersion: 'autobuild-2026-08-23-13-03',
        latestKnownVersion: 'autobuild-2026-08-24-14-04',
      })],
    })
    await mount()

    expect(document.body.textContent).toContain('2026-08-23 13:03')
    expect(document.body.textContent).toContain('2026-08-24 14:04')
    expect(document.body.textContent).not.toContain('autobuild')
  })
})
