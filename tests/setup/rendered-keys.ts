import { afterEach, beforeEach, expect } from 'vitest'
import { isLiteral, keysIn, keysRenderedIn, READ_ATTRIBUTES } from '../helpers/rendered-keys'

/**
 * The rendered-key gate (localization-conventions): every test that mounts the
 * interface fails if a catalogue key reaches the screen, as a text node or in an
 * attribute a person reads or hears. A key is a string, so neither the type
 * checker nor the source scan sees one rendered without the translator. Literal
 * content is marked `data-literal` and exempt (tests/helpers/rendered-keys.ts).
 *
 * It watches the document for the whole test rather than reading it at the end,
 * because each test file's own cleanup empties the body before this hook runs.
 */

let found = new Set<string>()
let observer: MutationObserver | null = null

function add(keys: string[]): void {
  for (const key of keys) found.add(key)
}

function record(records: MutationRecord[]): void {
  for (const change of records) {
    if (change.type === 'childList') change.addedNodes.forEach((node) => add(keysRenderedIn(node)))
    else if (change.type === 'characterData') { if (!isLiteral(change.target)) add(keysIn(change.target.nodeValue)) }
    else if (change.type === 'attributes' && change.attributeName) {
      add(keysIn((change.target as Element).getAttribute(change.attributeName)))
    }
  }
}

beforeEach(() => {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  found = new Set()
  observer = new MutationObserver(record)
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: READ_ATTRIBUTES,
  })
})

afterEach(() => {
  if (!observer) return
  record(observer.takeRecords())
  observer.disconnect()
  observer = null
  if (document.body) add(keysRenderedIn(document.body))
  expect([...found], 'catalogue keys rendered as text').toEqual([])
})
