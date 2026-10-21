// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
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
function editName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="text"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

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
      if (field === 'folder') button('Choose').click()
      else if (field === 'delete-after') [...document.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('Delete from library after export'))!.querySelector('input')!.click()
      else {
        editName('New name')
      }
    })
    expect(windowCloseState().dirty).toBe(true)
  })
})

describe('export destination submission', () => {
  it.each(['before', 'after'] as const)('keeps the chosen folder when editing the name %s selection and cancelling the next picker', async (when) => {
    const destinationDir = '/export/$LITERAL%name% '
    expect(document.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('Take')
    if (when === 'before') await act(async () => editName('Edited export'))
    ipcInvoke.mockResolvedValueOnce(destinationDir)
    await act(async () => button('Choose').click())
    if (when === 'after') await act(async () => editName('Edited export'))
    ipcInvoke.mockResolvedValueOnce(null)
    await act(async () => button('Choose').click())

    await act(async () => button('Export').click())

    expect(ipcInvoke).toHaveBeenCalledWith('export:files', {
      tapeId: tape.id, destinationDir, name: 'Edited export', deleteFromApp: false,
    })
  })

  it('submits the saved folder after Use default without losing the edited name', async () => {
    const destinationDir = '/saved/$DEFAULT%folder% '
    await act(async () => root.unmount())
    useSettingsStore.setState({ settings: { ...defaultSettings(), defaultExportDir: destinationDir, deleteAfterExport: false } })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root.render(createElement(ExportModal, { tape, videoRef: { current: null }, onClose: () => {} })))
    await act(async () => button('Choose').click())
    await act(async () => editName('Export after reset'))
    await act(async () => button(`Use default (${destinationDir})`).click())

    await act(async () => button('Export').click())

    expect(ipcInvoke).toHaveBeenCalledWith('export:files', {
      tapeId: tape.id, destinationDir, name: 'Export after reset', deleteFromApp: false,
    })
  })

  it('reopens a discarded draft with the saved folder and current filename', async () => {
    const destinationDir = '/saved/default '
    function ExportFlow() {
      const [open, setOpen] = useState(true)
      return open
        ? createElement(ExportModal, { tape, videoRef: { current: null }, onClose: () => setOpen(false) })
        : createElement('button', { onClick: () => setOpen(true) }, 'Open export')
    }
    useSettingsStore.setState({ settings: { ...defaultSettings(), defaultExportDir: destinationDir, deleteAfterExport: false } })
    await act(async () => root.render(createElement(ExportFlow)))
    await act(async () => button('Choose').click())
    await act(async () => editName('Abandoned export'))
    await act(async () => button('Cancel').click())
    await act(async () => button('Discard').click())
    expect(ipcInvoke.mock.calls.filter(([channel]) => channel === 'export:files')).toEqual([])
    await act(async () => button('Open export').click())

    await act(async () => button('Export').click())

    expect(ipcInvoke).toHaveBeenCalledWith('export:files', {
      tapeId: tape.id, destinationDir, name: 'Take', deleteFromApp: false,
    })
  })
})

describe('export folder picker context', () => {
  it('uses each selection as the next hint and keeps it on cancel', async () => {
    ipcInvoke.mockResolvedValueOnce('/export/$LITERAL%name% ')
    await act(async () => button('Choose').click())
    expect(ipcInvoke).toHaveBeenLastCalledWith('dialog:pickDirectory', expect.objectContaining({ initialDirectory: undefined }))
    ipcInvoke.mockResolvedValueOnce(null)
    await act(async () => button('Choose').click())
    expect(ipcInvoke).toHaveBeenLastCalledWith('dialog:pickDirectory', expect.objectContaining({ initialDirectory: '/export/$LITERAL%name% ' }))
    expect(document.querySelector('code')!.textContent).toBe('/export/$LITERAL%name% ')
  })

  it('uses the saved default first, then the per-export draft', async () => {
    await act(async () => root.unmount())
    useSettingsStore.setState({ settings: { ...defaultSettings(), defaultExportDir: '/saved/default ' } })
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root.render(createElement(ExportModal, { tape, videoRef: { current: null }, onClose: () => {} })))
    await act(async () => button('Choose').click())
    expect(ipcInvoke).toHaveBeenLastCalledWith('dialog:pickDirectory', expect.objectContaining({ initialDirectory: '/saved/default ' }))
    await act(async () => button('Choose').click())
    expect(ipcInvoke).toHaveBeenLastCalledWith('dialog:pickDirectory', expect.objectContaining({ initialDirectory: '/export' }))
  })
})
