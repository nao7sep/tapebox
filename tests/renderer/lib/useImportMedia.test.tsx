// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))

import { useImportMedia } from '@renderer/lib/useImportMedia'
import { useImportResultStore } from '@renderer/store/importResult'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement
let importMedia!: ReturnType<typeof useImportMedia>

function Harness() {
  importMedia = useImportMedia()
  return null
}

beforeEach(() => {
  ipcInvoke.mockReset()
  useImportResultStore.setState({ result: null, operationKey: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(React.createElement(Harness)))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('useImportMedia', () => {
  it('lets main account for the whole committed selection', async () => {
    ipcInvoke.mockResolvedValueOnce({
      imported: [],
      issues: [{
        path: '/tmp/poster.png',
        reason: 'TapeBox imports .json sidecars.',
        severity: 'warning',
      }],
    })
    await act(async () => importMedia(['/tmp/poster.png']))

    expect(ipcInvoke).toHaveBeenCalledWith('library:import', { paths: ['/tmp/poster.png'] })
    expect(useImportResultStore.getState().result?.issues[0]).toMatchObject({
      path: '/tmp/poster.png',
      reason: expect.stringContaining('.json sidecars'),
      severity: 'warning',
    })
  })

  it('keeps full success quiet without clearing an unresolved earlier result', async () => {
    useImportResultStore.getState().settle({
      operationKey: JSON.stringify(['/tmp/old.txt']),
      entryKey: 'import',
    }, {
      imported: [],
      issues: [{ path: '/tmp/old.txt', reason: 'Unsupported', severity: 'warning' }],
    })
    ipcInvoke.mockResolvedValueOnce({ imported: [{ id: 'tape-1' }], issues: [] })
    await act(async () => importMedia(['/tmp/sample.json']))
    expect(useImportResultStore.getState().result?.issues[0]?.path).toBe('/tmp/old.txt')
  })

  it('clears a result when the same import selection succeeds on retry', async () => {
    useImportResultStore.getState().settle({
      operationKey: JSON.stringify(['/tmp/sample.json']),
      entryKey: 'import',
    }, {
      imported: [],
      issues: [{ path: '/tmp/sample.json', reason: 'Copy failed', severity: 'error' }],
    })
    ipcInvoke.mockResolvedValueOnce({ imported: [{ id: 'tape-1' }], issues: [] })

    await act(async () => importMedia(['/tmp/sample.json']))

    expect(useImportResultStore.getState().result).toBeNull()
  })

  it('clears an entry-boundary failure after that entry point succeeds', async () => {
    useImportResultStore.getState().settle({ operationKey: 'picker', entryKey: 'picker' }, {
      imported: [],
      issues: [{ path: 'Import files', reason: 'Picker unavailable', severity: 'error' }],
    })
    ipcInvoke.mockResolvedValueOnce({ imported: [{ id: 'tape-1' }], issues: [] })

    await act(async () => importMedia(['/tmp/sample.json'], [], {
      operationKey: 'picker:["/tmp/sample.json"]',
      entryKey: 'picker',
    }))

    expect(useImportResultStore.getState().result).toBeNull()
  })

  it('clears a pre-resolution failure when the same native offer later succeeds', async () => {
    const attempt = {
      operationKey: 'drop:[["sample.json",2,42,"application/json"]]',
      entryKey: 'drop',
    }
    await act(async () => importMedia([], [{
      path: 'sample.json',
      reason: 'The file could not be resolved as a local path.',
      severity: 'error',
    }], attempt))
    expect(useImportResultStore.getState().result?.issues[0]?.path).toBe('sample.json')
    ipcInvoke.mockResolvedValueOnce({ imported: [{ id: 'tape-1' }], issues: [] })

    await act(async () => importMedia(['/tmp/sample.json'], [], attempt))

    expect(useImportResultStore.getState().result).toBeNull()
  })

  it('shows one combined partial result', async () => {
    ipcInvoke.mockResolvedValueOnce({
      imported: [{ id: 'tape-2' }],
      issues: [{ path: '/tmp/unrelated.txt', reason: 'Unsupported', severity: 'warning' }],
    })
    await act(async () => importMedia(['/tmp/next.json', '/tmp/next.mp4']))
    expect(useImportResultStore.getState().result).toMatchObject({
      imported: [{ id: 'tape-2' }],
      issues: [{ path: '/tmp/unrelated.txt', severity: 'warning' }],
    })
  })
})
