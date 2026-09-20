import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The variant table is read as text rather than rendered, because what is being
// checked is the rule each variant states — and a state a variant leaves unsaid
// shows nothing at all in a resting screenshot, which is how every one of the six
// came to have no pressed step.
const source = readFileSync(resolve('src/renderer/components/ui/Button.tsx'), 'utf8')

function variantClasses(): Map<string, string> {
  const table = source.match(/const VARIANT_CLASS[^{]*\{([\s\S]*?)\n\}/)
  if (table === null) throw new Error('Button.tsx no longer declares a VARIANT_CLASS table')
  const variants = new Map<string, string>()
  for (const [, name, classes] of table[1].matchAll(/(\w+):\s*\n?\s*((?:\s*'[^']*')+)/g))
    variants.set(name, [...classes.matchAll(/'([^']*)'/g)].map(([, part]) => part).join(' '))
  return variants
}

describe('Button variants', () => {
  const variants = variantClasses()

  it('declares the six variants the primitive types', () => {
    expect([...variants.keys()].sort()).toEqual([
      'danger', 'dangerOutline', 'ghost', 'primary', 'secondary', 'warm',
    ])
  })

  it.each([...variants])('answers a press on %s', (_name, classes) => {
    const pressed = classes.split(/\s+/).filter((utility) => utility.startsWith('active:'))
    expect(pressed.length, 'a press that shows nothing reads as a button that did nothing')
      .toBeGreaterThan(0)
  })

  // Off, a variant is its resting self faded: same fill, outline, ink, padding and
  // footprint, so it stays recognisably the control that will come back and the
  // variants stay told apart while they are off. Primary instead replaced its fill
  // and its ink, which is the failure the fleet convention names by that shape.
  it.each([...variants])('lets %s recede when disabled rather than reskinning it', (_name, classes) => {
    const off = classes
      .split(/\s+/)
      .filter((utility) => utility.startsWith('disabled:'))
      .map((utility) => utility.slice('disabled:'.length))

    expect(off.length).toBeGreaterThan(0)
    expect(off.filter((utility) => /^(bg|text|border)-/.test(utility))).toEqual([])
  })

  it('gives every variant the same disabled answer', () => {
    const answers = new Set(
      [...variants.values()].map((classes) =>
        classes.split(/\s+/).filter((utility) => utility.startsWith('disabled:')).sort().join(' '),
      ),
    )
    expect([...answers]).toHaveLength(1)
  })
})
