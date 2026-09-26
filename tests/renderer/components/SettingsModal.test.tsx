// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_MODEL, defaultSettings, type Settings } from '@shared/settings'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { SettingsModal } from '@renderer/components/SettingsModal'
import { useToastStore } from '@renderer/store/toast'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement
let saved: Settings
const onClose = vi.fn()

function stubMain(updateReply: (patch: Partial<Settings>) => unknown) {
  ipcInvoke.mockImplementation((channel: string, req?: unknown) => {
    if (channel === 'settings:get') return Promise.resolve(saved)
    if (channel === 'settings:hasApiKey') return Promise.resolve(false)
    if (channel === 'settings:defaultLibraryDir') return Promise.resolve('/home/me/.tapebox/library')
    if (channel === 'settings:update') return Promise.resolve(updateReply(req as Partial<Settings>))
    return Promise.resolve()
  })
}

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(SettingsModal, { onClose })))
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`No button labelled ${label}`)
  return found as HTMLButtonElement
}

async function click(label: string) {
  await act(async () => button(label).click())
}

beforeEach(() => {
  ipcInvoke.mockReset()
  onClose.mockReset()
  useToastStore.setState({ toasts: [] })
  saved = { ...defaultSettings(), ai: { ...defaultSettings().ai, model: 'retired-model' } }
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('SettingsModal', () => {
  it('Reset model returns the model to the shipped default and saves it', async () => {
    stubMain((patch) => ({ settings: { ...saved, ...patch }, warning: null }))
    await render()
    await click('AI')

    const model = document.getElementById('settings-ai-model') as HTMLInputElement
    expect(model.value).toBe('retired-model')
    await click('Reset model')
    expect(model.value).toBe(DEFAULT_AI_MODEL)
    expect(button('Reset model').disabled).toBe(true)

    await click('Save')
    const update = ipcInvoke.mock.calls.find(([channel]) => channel === 'settings:update')
    expect((update![1] as Partial<Settings>).ai?.model).toBe(DEFAULT_AI_MODEL)
  })

  it('treats a save main reports with a warning as saved, and keeps the warning on screen', async () => {
    const warning = 'Settings were saved and the library now uses the new folder, but some files could not be removed from the previous folder.'
    stubMain((patch) => ({ settings: { ...saved, ...patch }, warning }))
    await render()
    await click('AI')
    await click('Reset model')
    await click('Save')

    expect(onClose).toHaveBeenCalledOnce()
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ text: warning, kind: 'error' })])
  })
})
