import { createTranslator, type Message } from '@shared/i18n/translate'

// Renders a message the way an English interface shows it, so tests can keep
// asserting on the words a user reads.
const english = createTranslator('en', 'en-US')

export function inEnglish(message: Message | null | undefined): string | null {
  return message ? english.text(message) : null
}

/** Every message in a record, as an English interface shows it. */
export function inEnglishAll<K extends string>(
  record: Partial<Record<K, Message>> | undefined,
): Partial<Record<K, string>> | undefined {
  if (!record) return record
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, inEnglish(value as Message)]),
  ) as Partial<Record<K, string>>
}
