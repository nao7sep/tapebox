// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcInvoke, logError } = vi.hoisted(() => ({
  ipcInvoke: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { copyTapeSourceUrl, openTapeSourceUrl } from '@renderer/lib/tapeActions'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  ipcInvoke.mockReset()
  logError.mockReset()
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  useTapeActionResultsStore.setState({ byTape: {} })
})

describe('Detail source URL actions', () => {
  it('routes browser opening through the rejecting IPC and retains authored local copy', async () => {
    const hostile = new Error('Error invoking remote method: EACCES /private/tmp/TAPEBOX_OPEN_URL_SENTINEL')
    ipcInvoke.mockRejectedValueOnce(hostile)

    expect(await openTapeSourceUrl('tape-a', 'https://example.com/watch')).toBe(false)

    expect(ipcInvoke).toHaveBeenCalledWith('app:openExternal', { url: 'https://example.com/watch' })
    expect(useTapeActionResultsStore.getState().byTape['tape-a']).toEqual({
      'open-url': 'The source URL could not be opened in your browser. Try Open URL again.',
    })
    expect(JSON.stringify(useTapeActionResultsStore.getState().byTape)).not.toMatch(/EACCES|private\/tmp|SENTINEL|remote method/i)
    expect(JSON.stringify(logError.mock.calls)).toContain('TAPEBOX_OPEN_URL_SENTINEL')
  })

  it('retains clipboard failure independently and clears only that result on retry success', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError TAPEBOX_COPY_URL_SENTINEL'))
    useTapeActionResultsStore.getState().setResult('tape-a', 'open-url', 'Browser opening remains unresolved.')

    expect(await copyTapeSourceUrl('tape-a', 'https://example.com/watch')).toBe(false)
    expect(useTapeActionResultsStore.getState().byTape['tape-a']).toEqual({
      'open-url': 'Browser opening remains unresolved.',
      'copy-url': 'The source URL could not be copied. Try Copy URL again.',
    })
    expect(JSON.stringify(useTapeActionResultsStore.getState().byTape)).not.toContain('TAPEBOX_COPY_URL_SENTINEL')
    expect(JSON.stringify(logError.mock.calls)).toContain('TAPEBOX_COPY_URL_SENTINEL')

    expect(await copyTapeSourceUrl('tape-a', 'https://example.com/watch')).toBe(true)
    expect(writeText).toHaveBeenLastCalledWith('https://example.com/watch')
    expect(useTapeActionResultsStore.getState().byTape['tape-a']).toEqual({
      'open-url': 'Browser opening remains unresolved.',
    })
  })
})
