// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcInvoke = vi.hoisted(() => vi.fn())
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn() } }))

import { AboutModal } from '@renderer/components/AboutModal'
import { useRuntimeStore } from '@renderer/store/runtime'

const HOSTILE = 'EACCES /Users/nao/.tapebox/internal-browser-state.json'

describe('AboutModal external links', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    ipcInvoke.mockReset()
    useRuntimeStore.setState({ info: { version: '1.2.3', platform: 'darwin', arch: 'arm64' } })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(createElement(AboutModal, { onClose: () => undefined })))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  it('retains authored modal-local copy when the browser cannot open', async () => {
    ipcInvoke.mockRejectedValueOnce(new Error(HOSTILE))
    const github = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('GitHub'))!
    await act(async () => github.click())

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('GitHub could not be opened in your browser.')
    expect(host.textContent).not.toContain(HOSTILE)
    expect(ipcInvoke).toHaveBeenCalledWith('app:openExternal', { url: 'https://github.com/nao7sep/tapebox' })
  })

  it('keeps link results independent and ignores an older same-link failure', async () => {
    let rejectOlder!: (error: unknown) => void
    ipcInvoke
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOlder = reject }))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('issues unavailable'))
    const buttons = [...host.querySelectorAll('button')]
    const github = buttons.find((button) => button.textContent?.includes('GitHub'))!
    const issues = buttons.find((button) => button.textContent?.includes('Report an issue'))!

    await act(async () => { github.click(); github.click() })
    await act(async () => rejectOlder(new Error('stale EACCES /private/tmp/TAPEBOX_STALE')))
    expect(host.textContent).not.toContain('GitHub could not be opened')

    await act(async () => issues.click())
    expect(host.textContent).toContain('Report an issue could not be opened')
  })
})
