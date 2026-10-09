import { loadedCatalogue } from '@shared/i18n/catalogues'

/**
 * The rendered-key check behind the setup gate (localization-conventions): a
 * catalogue key that reaches the screen, as a text node or in an attribute a
 * person reads or hears, is an untranslated message. Key-shaped text inside an
 * element marked `data-literal` is content the app shows as it is — a tape's
 * title, a URL, a record — and may look like a key without being one.
 */

const KEYS = new Set(Object.keys(loadedCatalogue('en')))
export const READ_ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'label']
const KEY_LIKE = /[A-Za-z]\w*(?:\.\w+)+/g

/** Catalogue keys in `text`. */
export function keysIn(text: string | null | undefined): string[] {
  return (text?.match(KEY_LIKE) ?? []).filter((token) => KEYS.has(token))
}

/** Whether a text node is literal content rather than interface text. */
export function isLiteral(node: Node): boolean {
  return node.parentElement?.closest('[data-literal]') != null
}

/** Every catalogue key rendered in `node` and below. */
export function keysRenderedIn(node: Node): string[] {
  if (node.nodeType === 3 /* TEXT_NODE */) return isLiteral(node) ? [] : keysIn(node.nodeValue)
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return []
  const element = node as Element
  const found = READ_ATTRIBUTES.flatMap((name) => keysIn(element.getAttribute(name)))
  const walker = element.ownerDocument.createTreeWalker(element, 1 | 4 /* ELEMENT | TEXT */)
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    if (next.nodeType === 3) { if (!isLiteral(next)) found.push(...keysIn(next.nodeValue)) }
    else for (const name of READ_ATTRIBUTES) found.push(...keysIn((next as Element).getAttribute(name)))
  }
  return found
}
