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

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('The link could not be opened in your browser.')
    expect(host.textContent).not.toContain(HOSTILE)
    expect(ipcInvoke).toHaveBeenCalledWith('app:openExternal', { url: 'https://github.com/nao7sep/tapebox' })
  })
})
