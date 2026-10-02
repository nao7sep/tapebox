/**
 * Box-name rules, shared by the renderer (inline edit feedback) and the main
 * process (authoritative validation) so the rule lives in exactly one place.
 *
 * A box name must be non-empty, not a reserved word, and unique among the other
 * boxes — all compared case-insensitively after NFC normalization and trimming.
 */
import type { Language } from './i18n/languages'
import { message, type Message } from './i18n/translate'

/**
 * The implicit "no box" bucket's label (`boxes.unboxed`), in every interface
 * language. Not a real box, so each spelling is reserved: a user-created box must
 * not shadow it in any language the list may be shown in. Written out here
 * because only the interface language's catalogue is loaded; a test holds each
 * one equal to its catalogue's entry.
 */
export const UNBOXED_LABELS: Readonly<Record<Language, string>> = {
  en: 'Unboxed',
  de: 'Ohne Box',
  es: 'Sin caja',
  fr: 'Sans boîte',
  it: 'Senza scatola',
  'pt-BR': 'Sem caixa',
  ru: 'Без коробки',
  ja: 'ボックスなし',
  ko: '상자 없음',
  'zh-Hans': '未装盒',
}

const RESERVED_BOX_NAMES = Object.values(UNBOXED_LABELS)

export const normalizeBoxName = (name: string): string => name.normalize('NFC').trim()

/** One identity used by live validation and durable catalog validation. */
export const boxNameIdentity = (name: string): string => normalizeBoxName(name).toLowerCase()

/**
 * Validate a candidate box name. `takenNames` is the names of the *other*
 * boxes (exclude the one being renamed, so renaming to the same name is a
 * no-op, not a collision). Returns the message to show, or null when ok.
 */
export function boxNameError(name: string, takenNames: string[]): Message | null {
  const trimmed = normalizeBoxName(name)
  if (!trimmed) return message('boxes.nameEmpty')
  const identity = boxNameIdentity(trimmed)
  if (RESERVED_BOX_NAMES.some((r) => boxNameIdentity(r) === identity)) return message('boxes.nameReserved', { name: trimmed })
  if (takenNames.some((n) => boxNameIdentity(n) === identity)) return message('boxes.nameTaken', { name: trimmed })
  return null
}

/**
 * Derive a unique, non-reserved name from `desired` by appending " 2", " 3", …
 * until it's free. Used to seed new boxes with a valid starting name the user
 * then overtypes.
 */
export function uniqueBoxName(desired: string, takenNames: string[]): string {
  const normalized = normalizeBoxName(desired)
  if (boxNameError(normalized, takenNames) === null) return normalized
  for (let i = 2; ; i++) {
    const candidate = `${normalized} ${i}`
    if (boxNameError(candidate, takenNames) === null) return candidate
  }
}
