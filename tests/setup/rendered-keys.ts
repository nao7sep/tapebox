import { afterEach, beforeEach, expect } from 'vitest'
import { CATALOGUES } from '@shared/i18n/catalogues'

/**
 * The rendered-key gate (localization-conventions): every test that mounts the
 * interface fails if a catalogue key reaches the screen, as a text node or in an
 * attribute a person reads or hears. A key is a string, so neither the type
 * checker nor the source scan sees one rendered without the translator.
 *
 * It watches the document for the whole test rather than reading it at the end,
 * because each test file's own cleanup empties the body before this hook runs.
 */

const KEYS = new Set(Object.keys(CATALOGUES.en))
const READ_ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'label']
const KEY_LIKE = /[A-Za-z]\w*(?:\.\w+)+/g

let found = new Set<string>()
let observer: MutationObserver | null = null

function check(text: string | null | undefined): void {
  for (const token of text?.match(KEY_LIKE) ?? []) {
    if (KEYS.has(token)) found.add(token)
  }
}

function scan(node: Node): void {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    check(node.nodeValue)
    return
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return
  const element = node as Element
  for (const name of READ_ATTRIBUTES) check(element.getAttribute(name))
  const walker = element.ownerDocument.createTreeWalker(element, 1 | 4 /* ELEMENT | TEXT */)
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    if (next.nodeType === 3) check(next.nodeValue)
    else for (const name of READ_ATTRIBUTES) check((next as Element).getAttribute(name))
  }
}

function record(records: MutationRecord[]): void {
  for (const change of records) {
    if (change.type === 'childList') change.addedNodes.forEach(scan)
    else if (change.type === 'characterData') check(change.target.nodeValue)
    else if (change.type === 'attributes' && change.attributeName) {
      check((change.target as Element).getAttribute(change.attributeName))
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
  if (document.body) scan(document.body)
  expect([...found], 'catalogue keys rendered as text').toEqual([])
})
