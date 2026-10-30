// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc/client', () => ({ ipcInvoke: vi.fn(), ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn(), debug: vi.fn(), warn: vi.fn() } }))

import { FilterChips } from '@renderer/components/FilterChips'
import { useFilterStore } from '@renderer/store/filter'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  useFilterStore.setState({ filter: 'inbox' })
})

describe('FilterChips', () => {
  it('keeps selection and its keyboard mark visible alongside selected-chip hover', async () => {
    useFilterStore.setState({ filter: 'inbox' })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(createElement(FilterChips)))
    const radios = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    const selected = radios[0]!.closest('label')!
    expect(selected.className).toContain('bg-inverse')
    expect(selected.className).toContain('hover:bg-inverse-hover')
    expect(selected.className).toContain('has-[:focus-visible]:ring-2')
    await act(async () => {
      radios[0]!.focus()
      radios[1]!.closest('label')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(radios[0]!.checked).toBe(true)
    expect(document.activeElement).toBe(radios[0])
    expect(useFilterStore.getState().filter).toBe('inbox')
    await act(async () => radios[1]!.click())
    expect(useFilterStore.getState().filter).toBe('shelf')
    expect(radios[1]!.checked).toBe(true)
  })
})
