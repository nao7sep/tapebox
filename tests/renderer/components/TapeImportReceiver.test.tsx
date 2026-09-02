// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { importMedia, pathForFile, logError } = vi.hoisted(() => ({
  importMedia: vi.fn(),
  pathForFile: vi.fn(),
  logError: vi.fn(),
}))
vi.mock('@renderer/lib/useImportMedia', () => ({ useImportMedia: () => importMedia }))
vi.mock('@renderer/ipc/client', () => ({ pathForFile }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))

import { TapeImportReceiver } from '@renderer/components/TapeImportReceiver'
import { useImportResultStore } from '@renderer/store/importResult'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  importMedia.mockReset().mockResolvedValue(undefined)
  pathForFile.mockReset().mockImplementation((file: File) => `/tmp/${file.name}`)
  logError.mockReset()
    useImportResultStore.setState({ result: null, operationKey: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(
    React.createElement(TapeImportReceiver, null, React.createElement('div', null, 'Tape rows')),
  ))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function fileEvent(type: 'dragover' | 'drop', files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['Files'],
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      files,
      dropEffect: 'none',
    },
  })
  return event
}

describe('TapeImportReceiver', () => {
  it('highlights only its collection until a terminal event clears presentation', () => {
    const receiver = host.querySelector<HTMLElement>('[data-drop-receiver="tape-collection"]')!
    const over = fileEvent('dragover', [new File(['{}'], 'sample.json')])
    act(() => receiver.dispatchEvent(over))

    expect(over.defaultPrevented).toBe(true)
    expect(receiver.className).toContain('ring-amber-400')
    expect(document.body.textContent).not.toContain('Drop to check for tape sidecars')

    act(() => vi.advanceTimersByTime(1001))
    expect(receiver.className).toContain('ring-amber-400')

    act(() => receiver.dispatchEvent(new Event('dragleave', { bubbles: true })))
    expect(receiver.className).not.toContain('ring-amber-400')
  })

  it('delivers every dropped path to the shared admission path', async () => {
    const receiver = host.querySelector<HTMLElement>('[data-drop-receiver="tape-collection"]')!
    const sidecar = new File(['{}'], 'sample.json')
    const media = new File(['x'], 'sample.mp4')
    await act(async () => receiver.dispatchEvent(fileEvent('drop', [sidecar, media])))

    expect(importMedia).toHaveBeenCalledWith(
      ['/tmp/sample.json', '/tmp/sample.mp4'],
      [],
      { operationKey: expect.stringContaining('sample.json'), entryKey: 'drop' },
    )
  })

  it('renders a persistent prominent duplicate result beside the receiver', () => {
    act(() => useImportResultStore.getState().settle({ operationKey: 'duplicate', entryKey: 'drop' }, {
      imported: [],
      issues: [{ path: '/tmp/sample.json', reason: 'already in library', severity: 'information' }],
    }))

    const status = host.querySelector<HTMLElement>('[role="status"]')!
    expect(status.textContent).toContain('already in the library')
    expect(status.className).toContain('border-sky-500')
    expect(status.className).toContain('max-h-[40%]')
    expect(status.className).toContain('overflow-y-auto')
    expect(status.querySelector('button')?.getAttribute('aria-label')).toBe('Dismiss import result')
  })

  it('uses warning styling only for recoverable attention', () => {
    act(() => useImportResultStore.getState().settle({ operationKey: 'unsupported', entryKey: 'drop' }, {
      imported: [],
      issues: [{ path: '/tmp/notes.txt', reason: 'Unsupported', severity: 'warning' }],
    }))

    const status = host.querySelector<HTMLElement>('[role="status"]')!
    expect(status.className).toContain('border-amber-500')
    expect(status.textContent).toContain('Warning')
  })

  it('announces an import error assertively with structural severity', () => {
    act(() => useImportResultStore.getState().settle({ operationKey: 'failed', entryKey: 'drop' }, {
      imported: [],
      issues: [{ path: '/tmp/broken.json', reason: 'Unreadable', severity: 'error' }],
    }))

    const alert = host.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain('Error')
    expect(alert.textContent).toContain('The import failed.')
    expect(alert.className).toContain('border-red-500')
  })

  it('describes a successful import with duplicates as information, not failure', () => {
    act(() => useImportResultStore.getState().settle({ operationKey: 'mixed', entryKey: 'drop' }, {
      imported: [{ id: 'new-tape' } as never],
      issues: [{ path: '/tmp/old.json', reason: 'already in library', severity: 'information' }],
    }))

    const status = host.querySelector<HTMLElement>('[role="status"]')!
    expect(status.textContent).toContain('Added 1 new tape; 1 was already in the library.')
    expect(status.textContent).toContain('Information')
    expect(status.textContent).not.toContain('not added')
    expect(status.className).toContain('border-sky-500')
  })
})
