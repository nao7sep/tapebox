// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI_MODEL, DEFAULT_SLUG_PROMPT, defaultSettings, settingsAfterPatch, type Settings, type SettingsSets } from '@shared/settings'

const { ipcInvoke } = vi.hoisted(() => ({ ipcInvoke: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { SettingsModal } from '@renderer/components/SettingsModal'
import { AI_ROLES, SUPPORTED_MODELS } from '@shared/ai-models'
import { useToastStore } from '@renderer/store/toast'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement
let saved: Settings
const onClose = vi.fn()

function stubMain(updateReply: (patch: SettingsSets) => unknown) {
  ipcInvoke.mockImplementation((channel: string, req?: unknown) => {
    if (channel === 'settings:get') return Promise.resolve(saved)
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

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

    const model = document.getElementById('settings-openai-slug') as HTMLInputElement
    expect(model.value).toBe('retired-model')
    await click('Reset model')
    expect(model.value).toBe(DEFAULT_AI_MODEL)
    expect(button('Reset model').disabled).toBe(false)

    await click('Save')
    const update = ipcInvoke.mock.calls.find(([channel]) => channel === 'settings:update')
    expect(update![1]).toEqual({ 'openai.slug': DEFAULT_AI_MODEL })
    const endpoint = [...document.querySelectorAll('label')].find((label) => label.textContent === 'Endpoint')!.querySelector('input')!
    expect(endpoint.value).toBe('https://proxy.example/v1')
  })

  it('shows the OpenAI section alone, with no Provider control or model list', async () => {
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    await render()
    await click('AI')
    expect(document.querySelector('h3')!.textContent).toBe('OpenAI')
    expect(document.body.textContent).toContain('OpenAI is the only provider supported.')
    expect(document.querySelectorAll('select')).toHaveLength(0)
    expect(ipcInvoke.mock.calls.map(([channel]) => channel)).toEqual(['settings:get', 'settings:hasApiKey', 'settings:defaultLibraryDir'])
  })

  it('warns under the model field only while the id has no row', async () => {
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    await render()
    await click('AI')
    const warning = 'Not a supported model. It may not work as expected.'
    expect(document.body.textContent).toContain(warning)
    await type(document.getElementById('settings-openai-slug') as HTMLInputElement, ' GPT-6-Luna ')
    expect(document.body.textContent).not.toContain(warning)
  })

  it('shows the Thinking field for a listed model, resets it on a model change, and saves the choice', async () => {
    saved = defaultSettings()
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    await render()
    await click('AI')
    const thinking = () => document.getElementById('settings-openai-thinking-slug') as HTMLSelectElement | null
    expect(thinking()!.value).toBe('none')
    expect([...thinking()!.options].map((option) => option.value)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    const model = document.getElementById('settings-openai-slug') as HTMLInputElement
    await type(model, 'my-local-model')
    expect(thinking()).toBeNull()
    // Each row shows its own values in its order and takes its own tier's
    // default, whatever the role's kind.
    for (const row of SUPPORTED_MODELS) {
      await type(model, row.id)
      expect(thinking()!.value, row.id).toBe(row.defaultThinking)
      expect([...thinking()!.options].map((option) => option.value), row.id).toEqual(row.thinking)
    }
    await act(async () => {
      thinking()!.value = 'xhigh'
      thinking()!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await type(model, 'gpt-6.1-sol')
    expect(thinking()!.value).toBe('medium')
    expect([...thinking()!.options].map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    await act(async () => {
      thinking()!.value = 'high'
      thinking()!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('Save')
    expect(ipcInvoke.mock.calls.find(([channel]) => channel === 'settings:update')![1]).toEqual({
      'openai.slug': 'gpt-6.1-sol', 'openai.thinking.slug': 'high',
    })
  })

  describe('Thinking on a model edit', () => {
    const thinking = () => document.getElementById('settings-openai-thinking-slug') as HTMLSelectElement | null
    const model = () => document.getElementById('settings-openai-slug') as HTMLInputElement

    async function chooseThinking(value: string) {
      await act(async () => {
        thinking()!.value = value
        thinking()!.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }

    beforeEach(async () => {
      saved = defaultSettings()
      stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
      await render()
      await click('AI')
      await chooseThinking('xhigh')
    })

    it.each([
      ['a trailing space', `${DEFAULT_AI_MODEL} `],
      ['a leading space', ` ${DEFAULT_AI_MODEL}`],
      ['a different case', DEFAULT_AI_MODEL.toUpperCase()],
      ['the same id retyped', DEFAULT_AI_MODEL],
    ])('keeps the chosen value for %s', async (_, id) => {
      await type(model(), id)
      expect(thinking()!.value).toBe('xhigh')
    })

    it('resets to the new model\'s default for a different supported id', async () => {
      const other = SUPPORTED_MODELS.find((row) => row.id !== DEFAULT_AI_MODEL && row.thinking.includes('xhigh'))!
      await type(model(), other.id)
      expect(thinking()!.value).toBe(other.defaultThinking)
    })

    it('keeps the chosen value, hidden, through an unlisted id back to the same row', async () => {
      await type(model(), 'my-local-model')
      expect(thinking()).toBeNull()
      await type(model(), DEFAULT_AI_MODEL)
      expect(thinking()!.value).toBe('xhigh')
    })

    it('keeps the chosen value when one letter is deleted and retyped', async () => {
      await type(model(), DEFAULT_AI_MODEL.slice(0, -1))
      expect(thinking()).toBeNull()
      await type(model(), DEFAULT_AI_MODEL)
      expect(thinking()!.value).toBe('xhigh')
    })

    it('resets to the new model\'s default for a different supported id reached through an unlisted id', async () => {
      const other = SUPPORTED_MODELS.find((row) => row.id !== DEFAULT_AI_MODEL && row.thinking.includes('xhigh') && row.defaultThinking !== 'xhigh')!
      await type(model(), 'gpt-')
      await type(model(), other.id)
      expect(thinking()!.value).toBe(other.defaultThinking)
    })
  })

  it.each(AI_ROLES)('has a model field for the $id role that saves its own set as typed', async (role) => {
    stubMain((patch) => ({ settings: settingsAfterPatch(saved, patch), warning: null }))
    await render()
    await click('AI')
    const input = document.getElementById(`settings-openai-${role.id}`) as HTMLInputElement
    expect(input.value).toBe(saved[`openai.${role.id}`])
    await type(input, 'my-local-model')
    await click('Save')
    expect(ipcInvoke.mock.calls.find(([channel]) => channel === 'settings:update')![1]).toEqual({
      [`openai.${role.id}`]: 'my-local-model',
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
