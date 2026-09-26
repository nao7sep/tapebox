import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { presentFailure } from '@renderer/lib/presentFailure'
import { IpcCallError } from '@shared/ipc-reply'

const FALLBACK = 'Settings could not be saved. Your changes are still shown; try again.'

describe('presentFailure', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the copy main authored for the user instead of the generic fallback', () => {
    const error = new IpcCallError('settings:update', {
      code: 'refused',
      userMessage: "Can't move the library while downloads are running.",
    })
    expect(presentFailure(error, FALLBACK, 'settings save failed')).toBe(
      "Can't move the library while downloads are running.",
    )
    expect(logError).toHaveBeenCalledWith('settings save failed', expect.anything())
  })

  it('falls back to the operation copy for an internal failure or any other error', () => {
    const internal = new IpcCallError('settings:update', { code: 'internal', userMessage: null })
    expect(presentFailure(internal, FALLBACK, 'settings save failed')).toBe(FALLBACK)

    const hostile = new Error('EACCES /private/tmp/HOSTILE-SENTINEL Error invoking remote method')
    const shown = presentFailure(hostile, FALLBACK, 'settings save failed')
    expect(shown).toBe(FALLBACK)
    expect(shown).not.toContain('HOSTILE-SENTINEL')
    expect(JSON.stringify(logError.mock.calls)).toContain('HOSTILE-SENTINEL')
  })
})
