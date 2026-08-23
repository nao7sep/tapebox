// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { importMedia } = vi.hoisted(() => ({ importMedia: vi.fn() }))
vi.mock('@renderer/lib/useImportMedia', () => ({ useImportMedia: () => importMedia }))
vi.mock('@renderer/ipc/client', () => ({ pathForFile: vi.fn() }))

import { DropZone, inspectSidecarDragOffer } from '@renderer/components/DropZone'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(React.createElement(DropZone, null, React.createElement('div', null, 'content'))))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function fileDrag(type: 'dragenter' | 'dragover', inspectable = false): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: ['Files'],
      items: inspectable
        ? [{ kind: 'file', getAsFile: () => new File(['{}'], 'tape.json') }]
        : [],
      files: [],
      dropEffect: 'none',
    },
  })
  return event
}

describe('DropZone external drag affordance', () => {
  it('uses sentence-case guidance and independently clears a cancelled OS drag', () => {
    const wrapper = host.firstElementChild!
    act(() => wrapper.dispatchEvent(fileDrag('dragenter', true)))
    expect(document.body.textContent).toContain('Drop the .json sidecars')

    act(() => vi.advanceTimersByTime(1001))
    expect(document.body.textContent).not.toContain('Drop to restore tapes')
  })

  it('ignores non-file drags', () => {
    const event = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'], items: [] } })
    act(() => host.firstElementChild!.dispatchEvent(event))
    expect(document.body.textContent).not.toContain('Drop to restore tapes')
  })

  it('keeps a protected Files offer delivery-only', () => {
    const wrapper = host.firstElementChild!
    const over = fileDrag('dragover')
    act(() => wrapper.dispatchEvent(over))
    expect(over.defaultPrevented).toBe(true)
    expect((over as Event & { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe('none')
    expect(document.body.textContent).not.toContain('Drop to restore tapes')
  })

  it('classifies only inspectable JSON file items as accepted', () => {
    expect(inspectSidecarDragOffer({
      types: ['Files'],
      items: [] as unknown as DataTransferItemList,
    })).toBe('delivery-only')
    expect(inspectSidecarDragOffer({
      types: ['Files'],
      items: [{ kind: 'file', getAsFile: () => new File(['x'], 'clip.mp4') }] as unknown as DataTransferItemList,
    })).toBe('rejected')
  })
})
