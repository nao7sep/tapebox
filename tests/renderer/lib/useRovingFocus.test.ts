// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useRovingFocus } from '@renderer/lib/useRovingFocus'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView; the hook calls it on a selected row.
  Element.prototype.scrollIntoView = () => {}
})

let root: Root | null = null

function Row({ active, selected }: { active: boolean; selected: boolean }): React.ReactElement {
  const ref = useRovingFocus<HTMLButtonElement>(active, selected)
  return React.createElement('button', { ref, id: 'row' }, 'row')
}

// An input sits alongside the row so we can assert focus is never yanked out of a
// text field.
function Tree({ active, selected }: { active: boolean; selected: boolean }): React.ReactElement {
  return React.createElement(
    'div',
    null,
    React.createElement('input', { id: 'inp' }),
    React.createElement(Row, { active, selected }),
  )
}

async function render(active: boolean, selected: boolean): Promise<void> {
  if (root === null) {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root!.render(React.createElement(Tree, { active, selected }))
  })
}

const row = () => document.getElementById('row')
const input = () => document.getElementById('inp') as HTMLInputElement

afterEach(async () => {
  if (root !== null) {
    await act(async () => { root?.unmount() })
    root = null
  }
  document.body.innerHTML = ''
})

describe('useRovingFocus', () => {
  it('focuses the selected row of the active list', async () => {
    await render(true, true)
    expect(document.activeElement).toBe(row())
  })

  it('does not take focus when the list is inactive', async () => {
    await render(false, true)
    expect(document.activeElement).not.toBe(row())
  })

  it('does not take focus for an unselected row', async () => {
    await render(true, false)
    expect(document.activeElement).not.toBe(row())
  })

  it('never steals focus from a text field', async () => {
    await render(false, false)
    await act(async () => { input().focus() })
    expect(document.activeElement).toBe(input())

    // The row becomes active+selected while the input holds focus — it must not grab.
    await render(true, true)
    expect(document.activeElement).toBe(input())
  })
})
