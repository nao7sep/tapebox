// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  denyUnhandledExternalDrop,
  droppedFileOperationKey,
  inspectExternalFileOffer,
  resolveDroppedPaths,
} from '@renderer/lib/externalDrop'

describe('external drop boundary', () => {
  it('keeps every protected or inspectable file offer deliverable', () => {
    expect(inspectExternalFileOffer({
      types: ['Files'],
      items: [] as unknown as DataTransferItemList,
    })).toBe('delivery-only')
    expect(inspectExternalFileOffer({
      types: ['Files'],
      items: [{ kind: 'file', getAsFile: () => new File(['x'], 'clip.mp4') }] as unknown as DataTransferItemList,
    })).toBe('delivery-only')
  })

  it('retains editable text drops and denies unowned files or text', () => {
    const makeEvent = (target: Element, types: string[]) => {
      const event = new Event('drop', { cancelable: true }) as Event & {
        dataTransfer: { types: string[]; items: never[]; dropEffect: DataTransfer['dropEffect'] }
      }
      Object.defineProperties(event, {
        target: { value: target },
        dataTransfer: { value: { types, items: [], dropEffect: 'copy' } },
      })
      return event
    }

    const text = makeEvent(document.createElement('textarea'), ['text/plain'])
    denyUnhandledExternalDrop(text)
    expect(text.defaultPrevented).toBe(false)

    const file = makeEvent(document.createElement('div'), ['Files'])
    denyUnhandledExternalDrop(file)
    expect(file.defaultPrevented).toBe(true)
    expect(file.dataTransfer.dropEffect).toBe('none')

    const unownedText = makeEvent(document.createElement('div'), ['text/plain'])
    denyUnhandledExternalDrop(unownedText)
    expect(unownedText.defaultPrevented).toBe(true)
  })

  it('accounts for literal repeats and path-resolution failures', () => {
    const first = new File(['{}'], 'first.json')
    const repeated = new File(['{}'], 'repeated.json')
    const inaccessible = new File(['{}'], 'inaccessible.json')
    const resolved = resolveDroppedPaths([first, repeated, inaccessible], (file) => {
      if (file === inaccessible) throw new Error('unavailable')
      return '/tmp/tape.json'
    })

    expect(resolved.paths).toEqual(['/tmp/tape.json'])
    expect(resolved.issues).toMatchObject([
      { severity: 'information' },
      { severity: 'error' },
    ])
    expect(resolved.errors[0]?.error).toBeInstanceOf(Error)
  })

  it('identifies the same native files before path resolution succeeds', () => {
    const first = new File(['{}'], 'sample.json', { type: 'application/json', lastModified: 42 })
    const second = new File(['video'], 'sample.mp4', { type: 'video/mp4', lastModified: 43 })

    expect(droppedFileOperationKey([first, second])).toBe(droppedFileOperationKey([second, first]))
    expect(droppedFileOperationKey([first])).not.toBe(droppedFileOperationKey([second]))
  })

  it('accounts for a protected offer that delivers no accessible files', () => {
    expect(resolveDroppedPaths([], () => '')).toMatchObject({
      paths: [],
      issues: [{
        path: 'Dropped files',
        reason: expect.stringContaining('not available'),
        severity: 'warning',
      }],
    })
  })
})
