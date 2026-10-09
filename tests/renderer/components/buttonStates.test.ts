// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Button, type ButtonVariant } from '@renderer/components/ui/Button'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Each variant is rendered and its classes read off the button, because what is
// checked is the rule each variant states: a state a variant leaves unsaid shows
// nothing at all in a resting screenshot, which is how every one of the six came
// to have no pressed step.

// Every variant the primitive types, no more: the type checker fails this table
// when one is added or removed.
const EVERY_VARIANT: Record<ButtonVariant, true> = {
  danger: true, dangerOutline: true, ghost: true, primary: true, secondary: true, warm: true,
}
const VARIANTS = Object.keys(EVERY_VARIANT) as ButtonVariant[]

function rendered(variant: ButtonVariant): string[] {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(createElement(Button, { variant, children: 'Label' })))
  const classes = host.querySelector('button')!.className.split(/\s+/)
  act(() => root.unmount())
  return classes
}

describe('Button variants', () => {
  it.each(VARIANTS)('answers a press on %s', (variant) => {
    const pressed = rendered(variant).filter((utility) => utility.startsWith('active:'))
    expect(pressed.length, 'a press that shows nothing reads as a button that did nothing').toBeGreaterThan(0)
  })

  // Off, a variant is its resting self faded: same fill, outline, ink, padding and
  // footprint, so it stays recognisably the control that will come back and the
  // variants stay told apart while they are off. Primary instead replaced its fill
  // and its ink, which is the failure the fleet convention names by that shape.
  it.each(VARIANTS)('lets %s recede when disabled rather than reskinning it', (variant) => {
    const off = rendered(variant)
      .filter((utility) => utility.startsWith('disabled:'))
      .map((utility) => utility.slice('disabled:'.length))
    expect(off.length).toBeGreaterThan(0)
    expect(off.filter((utility) => /^(bg|text|border)-/.test(utility))).toEqual([])
  })

  it('gives every variant the same disabled answer', () => {
    const answers = new Set(VARIANTS.map((variant) =>
      rendered(variant).filter((utility) => utility.startsWith('disabled:')).sort().join(' ')))
    expect([...answers]).toHaveLength(1)
  })
})
