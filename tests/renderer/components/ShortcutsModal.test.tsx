// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ShortcutsModal } from '@renderer/components/ShortcutsModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('ShortcutsModal catalogue', () => {
  it('advertises J/L as alternate seek keys alongside Left/Right', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(React.createElement(ShortcutsModal, { onClose: vi.fn() })))

    const kbds = Array.from(host.querySelectorAll('kbd')).map((el) => el.textContent)
    expect(kbds).toContain('Left/J / Right/L')
  })
})
