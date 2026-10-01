// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_MODEL, DEFAULT_SLUG_PROMPT, defaultSettings, settingsAfterPatch, type Settings, type SettingsSets } from '@shared/settings'

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

function stubMain(updateReply: (patch: SettingsSets) => unknown) {
  ipcInvoke.mockImplementation((channel: string, req?: unknown) => {
    if (channel === 'settings:get') return Promise.resolve(saved)
    if (channel === 'settings:modelList') return Promise.resolve([])
    if (channel === 'settings:hasApiKey') return Promise.resolve(false)
    if (channel === 'settings:defaultLibraryDir') return Promise.resolve('/home/me/.tapebox/library')
    if (channel === 'settings:update') return Promise.resolve(updateReply(req as SettingsSets))
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
  saved = { ...defaultSettings(), 'openai.slug': 'retired-model' }
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('SettingsModal', () => {
  it('lists System first, then each language by its own name, and saves the choice', async () => {
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    await render()

    const select = document.querySelector('select') as HTMLSelectElement
    const options = [...select.options]
    expect(options[0]!.value).toBe('system')
    expect(options.map((option) => option.textContent)).toEqual([
      'System', 'English', 'Deutsch', 'Español', 'Français', 'Italiano', 'Português', 'Русский', '日本語', '한국어', '中文',
    ])
    expect(options.slice(1).map((option) => option.lang)).toEqual(['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'ja', 'ko', 'zh-Hans'])

    await act(async () => {
      select.value = 'ja'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('Save')
    const update = ipcInvoke.mock.calls.find(([channel]) => channel === 'settings:update')
    expect(update![1]).toEqual({ language: 'ja' })
  })

  it('Reset model fills the draft with the built-in model and keeps the endpoint', async () => {
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    saved['openai.endpoint'] = 'https://proxy.example/v1'
    await render()
    await click('AI')

    const model = document.getElementById('settings-ai-model') as HTMLInputElement
    expect(model.value).toBe('retired-model')
    await click('Reset model')
    expect(model.value).toBe(DEFAULT_AI_MODEL)
    expect(button('Reset model').disabled).toBe(false)

    await click('Save')
    const update = ipcInvoke.mock.calls.find(([channel]) => channel === 'settings:update')
    expect(update![1]).toEqual({ 'openai.slug': DEFAULT_AI_MODEL })
    expect((document.querySelector('input[placeholder="https://api.openai.com/v1"]') as HTMLInputElement).value).toBe('https://proxy.example/v1')
  })

  it('shows grouped sources and the out-of-list selection without replacing it', async () => {
    saved.extraModelIds = { openai: ['local-model'] }
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    ipcInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') return Promise.resolve(saved)
      if (channel === 'settings:modelList') return Promise.resolve(['gpt-fetched'])
      return Promise.resolve(false)
    })
    await render()
    await click('AI')
    const picker = document.querySelector('select[aria-labelledby="settings-ai-model-label"]') as HTMLSelectElement
    expect([...picker.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['App suggestions', 'Provider models', 'Your extra models'])
    expect([...picker.options].map((option) => option.value)).toEqual(['retired-model', 'gpt-6-luna', 'gpt-fetched', 'local-model'])
    expect(picker.value).toBe('retired-model')
    await click('Refresh models')
    expect(ipcInvoke).toHaveBeenCalledWith('settings:modelList', { endpoint: saved['openai.endpoint'], force: true })
  })

  it('persists a typed unknown id as the selection and an extra without changing endpoint', async () => {
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    await render()
    await click('AI')
    const input = document.getElementById('settings-ai-model') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my-local-model')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Save')
    expect(ipcInvoke.mock.calls.find(([channel]) => channel === 'settings:update')![1]).toEqual({
      'openai.slug': 'my-local-model', extraModelIds: { openai: ['my-local-model'] },
    })
  })

  it('Reset slug prompt fills the draft with the built-in and saves it as the whole set', async () => {
    saved.prompts = { slug: 'my custom prompt' }
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    await render()
    await click('AI')
    await click('Reset slug prompt')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(DEFAULT_SLUG_PROMPT)
    await click('Save')
    expect(ipcInvoke.mock.calls.find(([channel]) => channel === 'settings:update')![1]).toEqual({ prompts: { slug: DEFAULT_SLUG_PROMPT } })
  })

  it('saving only an API key does not write any settings sets', async () => {
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    await render()
    await click('AI')
    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'test-key')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Save')
    expect(ipcInvoke).toHaveBeenCalledWith('settings:setApiKey', { apiKey: 'test-key' })
    expect(ipcInvoke.mock.calls.some(([channel]) => channel === 'settings:update')).toBe(false)
  })

  it('treats a save main reports with a warning as saved, and keeps the warning on screen', async () => {
    const warning = 'Settings were saved and the library now uses the new folder, but some files could not be removed from the previous folder.'
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning }))
    await render()
    await click('AI')
    await click('Reset model')
    await click('Save')

    expect(onClose).toHaveBeenCalledOnce()
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ text: warning, kind: 'error' })])
  })
})
