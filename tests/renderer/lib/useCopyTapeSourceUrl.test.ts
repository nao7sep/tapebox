// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { useCopyTapeSourceUrl } from '@renderer/lib/useCopyTapeSourceUrl'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'

let writeText: ReturnType<typeof vi.fn>
let root: Root
let hook: ReturnType<typeof useCopyTapeSourceUrl>

function Harness({ tapeId, sourceUrl }: { tapeId: string; sourceUrl: string }) {
  hook = useCopyTapeSourceUrl(tapeId, sourceUrl)
  return null
}

beforeEach(() => {
  logError.mockReset()
  writeText = vi.fn()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  useTapeActionResultsStore.setState({ byTape: {} })
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.querySelector('#root')!)
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

async function render(tapeId: string, sourceUrl: string): Promise<void> {
  await act(async () => root.render(createElement(Harness, { tapeId, sourceUrl })))
}

describe('Copy URL acknowledgement ownership', () => {
  it('does not carry Copied to a newly selected tape or accept the old tape’s late success', async () => {
    let resolveOld!: () => void
    writeText.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOld = resolve }))
    await render('tape-old', 'https://example.com/old')

    let oldCopy!: Promise<void>
    act(() => { oldCopy = hook.copy() })
    await render('tape-new', 'https://example.com/new')
    await act(async () => { resolveOld(); await oldCopy })

    expect(hook.copied).toBe(false)
  })

  it('does not show Copied when an older success settles after the latest attempt failed', async () => {
    let resolveOlder!: () => void
    writeText
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveOlder = resolve }))
      .mockRejectedValueOnce(new Error('NotAllowedError TAPEBOX_LATEST_COPY_SENTINEL'))
    await render('tape-current', 'https://example.com/current')

    let olderCopy!: Promise<void>
    let newerCopy!: Promise<void>
    act(() => {
      olderCopy = hook.copy()
      newerCopy = hook.copy()
    })
    await act(async () => { await newerCopy })
    await act(async () => { resolveOlder(); await olderCopy })

    expect(hook.copied).toBe(false)
    expect(useTapeActionResultsStore.getState().byTape['tape-current']).toEqual({
      'copy-url': 'The source URL could not be copied. Try Copy URL again.',
    })
  })
})
