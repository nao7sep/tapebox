// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { RenameModal } from '@renderer/components/RenameModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A typed name is the user's work: closing the dialog asks before dropping it
// (unsaved-edits-conventions), and an untouched dialog closes at once.

let root: Root | null = null
const onClose = vi.fn()
const tape = { id: 'Rename0001', title: 'A Title', uploader: null, name: 'Take', filename: 'Take.mp4' } as Tape

beforeEach(async () => {
  onClose.mockReset()
  ipcInvoke.mockReset().mockImplementation(async (channel: string) => (channel === 'library:getSidecar' ? {} : undefined))
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(RenameModal, { tape, onRename: async () => {}, onClose })))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`No button labelled ${label}`)
  return found as HTMLButtonElement
}

async function type(value: string) {
  const input = document.querySelector('[role="dialog"] input') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('RenameModal', () => {
  it('closes at once when nothing was typed', async () => {
    await act(async () => button('Cancel').click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('asks before dropping a typed name, keeping it on Keep editing', async () => {
    await type('Another name')
    await act(async () => button('Cancel').click())
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Discard your changes?')

    await act(async () => button('Keep editing').click())
    expect(onClose).not.toHaveBeenCalled()
    expect((document.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe('Another name')

    await act(async () => button('Cancel').click())
    await act(async () => button('Discard').click())
    expect(onClose).toHaveBeenCalledOnce()
  })
})
