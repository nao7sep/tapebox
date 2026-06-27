// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useUiFont } from '@renderer/lib/useUiFont'
import { useSettingsStore } from '@renderer/store/settings'
import { defaultSettings, type Settings } from '@shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

function Harness(): null {
  useUiFont()
  return null
}

async function mount(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(React.createElement(Harness))
  })
}

function setSettings(patch: Partial<Settings>): void {
  useSettingsStore.getState().setSettings({ ...defaultSettings(), ...patch })
}

beforeEach(() => {
  useSettingsStore.setState({ settings: null })
  document.documentElement.style.removeProperty('--font-sans')
})

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount())
    root = null
  }
  document.documentElement.style.removeProperty('--font-sans')
})

const fontSans = () => document.documentElement.style.getPropertyValue('--font-sans')

describe('useUiFont', () => {
  it('leaves --font-sans unset (uses the @theme default) when the family is blank', async () => {
    setSettings({ uiFontFamily: '' })
    await mount()
    expect(fontSans()).toBe('')
  })

  it('overrides --font-sans verbatim when a family is configured', async () => {
    setSettings({ uiFontFamily: 'Iosevka, monospace' })
    await mount()
    expect(fontSans()).toBe('Iosevka, monospace')
  })

  it('reverts to the default by clearing the override when the family is emptied', async () => {
    setSettings({ uiFontFamily: 'Iosevka' })
    await mount()
    expect(fontSans()).toBe('Iosevka')

    await act(async () => setSettings({ uiFontFamily: '' }))
    expect(fontSans()).toBe('')
  })

  it('treats a whitespace-only family as blank', async () => {
    setSettings({ uiFontFamily: '   ' })
    await mount()
    expect(fontSans()).toBe('')
  })
})
