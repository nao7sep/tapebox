// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Toaster } from '@renderer/components/Toaster'
import { useToastStore } from '@renderer/store/toast'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.body.innerHTML = ''
  useToastStore.setState({ toasts: [] })
})

describe('Toaster error results', () => {
  it('stacks persistent errors as labelled alerts and dismisses only the chosen result', async () => {
    useToastStore.getState().notify('First failure', 'error')
    useToastStore.getState().notify('Second failure', 'error')
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(React.createElement(Toaster)))

    const alerts = document.querySelectorAll('[role="alert"]')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]?.textContent).toContain('Error')
    expect(alerts[0]?.textContent).toContain('First failure')

    await act(async () => {
      alerts[0]?.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('Second failure')
  })
})
