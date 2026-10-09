// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { keysRenderedIn } from '../helpers/rendered-keys'

// The rendered-key check itself: it must catch an untranslated message and must
// accept literal content that merely looks like a key.

function dom(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host
}

describe('the rendered-key check', () => {
  it('catches a key rendered as interface text or in a read attribute', () => {
    expect(keysRenderedIn(dom('<p>settings.title</p>'))).toEqual(['settings.title'])
    expect(keysRenderedIn(dom('<button aria-label="common.cancel">x</button>'))).toEqual(['common.cancel'])
  })

  it('accepts literal content that looks like a key, and only inside its boundary', () => {
    const host = dom('<h2 data-literal>settings.title</h2><span>common.cancel</span>')
    expect(keysRenderedIn(host)).toEqual(['common.cancel'])
  })

  it('still reads the attributes of a literal element, where interface text lives', () => {
    expect(keysRenderedIn(dom('<button data-literal aria-label="common.cancel">https://x.test/settings.title</button>'))).toEqual(['common.cancel'])
  })
})
