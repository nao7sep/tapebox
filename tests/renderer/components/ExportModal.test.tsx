// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { defaultSettings } from '@shared/settings'
import { ExportModal } from '@renderer/components/ExportModal'
import { useSettingsStore } from '@renderer/store/settings'
import { windowCloseState } from '@renderer/lib/windowClose'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const tape = { id: 'Export0001', title: 'A Title', uploader: null, name: 'Take', filename: 'Take.mp4' } as Tape
function button(label: string) { return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)! }

beforeEach(async () => {
  ipcInvoke.mockReset().mockImplementation(async (channel) => channel === 'dialog:pickDirectory' ? '/export' : {})
  useSettingsStore.setState({ settings: { ...defaultSettings(), defaultExportDir: '', deleteAfterExport: false } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(ExportModal, { tape, videoRef: { current: null }, onClose: () => {} })))
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

describe('export draft window protection', () => {
  it.each(['name', 'folder', 'delete-after'] as const)('protects a changed %s', async (field) => {
    expect(windowCloseState().dirty).toBe(false)
    await act(async () => {
      if (field === 'folder') button('Choose…').click()
      else if (field === 'delete-after') [...document.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('Delete from library after export'))!.querySelector('input')!.click()
      else {
        const input = document.querySelector('input')!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'New name')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    expect(windowCloseState().dirty).toBe(true)
  })

  it('keeps the renderer alive while an export is submitted', async () => {
    await act(async () => button('Choose…').click())
    ipcInvoke.mockImplementation(() => new Promise(() => {}))
    await act(async () => button('Export').click())
    expect(windowCloseState().busy).toBe(true)
  })
})
