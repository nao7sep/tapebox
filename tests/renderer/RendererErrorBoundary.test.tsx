// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const logError = vi.hoisted(() => vi.fn())
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { RendererErrorBoundary } from '@renderer/components/RendererErrorBoundary'

const HOSTILE = 'EACCES /Users/nao/.tapebox/quarantine/internal-state.json'

function Broken(): React.JSX.Element { throw new Error(HOSTILE) }

describe('RendererErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks())
  it('retains authored recovery copy and keeps diagnostics out of the window', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<RendererErrorBoundary><Broken /></RendererErrorBoundary>))

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('TapeBox could not keep this window open.')
    expect(host.textContent).not.toContain(HOSTILE)
    expect(logError).toHaveBeenCalledWith(
      'renderer stopped unexpectedly',
      expect.objectContaining({ error: expect.objectContaining({ message: HOSTILE }) }),
    )
    await act(async () => root.unmount())
    host.remove()
  })
})
