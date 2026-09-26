import { CATALOGUES, type Catalogue, type MessageKey } from './catalogues'
import type { Language } from './languages'

/**
 * Text held in state or sent across IPC (a failure, a toast, an import issue) is
 * a key plus values, never a finished string, so it renders in whatever language
 * is current when it is shown. A value may be another message, rendered in the
 * same language: a reason inside a sentence, or the rest of a joined line.
 */
export type MessageValue = string | number | Message
export type MessageValues = Record<string, MessageValue>

export type Message = {
  key: MessageKey
  values?: MessageValues
}

export function message(key: MessageKey, values?: MessageValues): Message {
  return values === undefined ? { key } : { key, values }
}

/**
 * Stack messages through the one `common.join` entry, so each part keeps its own
 * plural form and each language chooses the separator; never a joined string.
 */
export function joinMessages(first: Message, ...rest: MessageValue[]): Message {
  return rest.reduce<Message>((joined, next) => message('common.join', { first: joined, rest: next }), first)
}

export function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && typeof (value as { key?: unknown }).key === 'string'
}

const PLACEHOLDER = /\{(\w+)\}/g

type RelativeUnit = 'second' | 'minute' | 'hour' | 'day'

export type Translator = {
  language: Language
  locale: string
  t: (key: MessageKey, values?: MessageValues) => string
  text: (message: Message) => string
  /** The entry for `key` (a plural entry chosen by `count`), placeholders unfilled. */
  template: (key: MessageKey, count?: number) => string
  number: (value: number) => string
  percent: (ratio: number) => string
  /** A byte count in the largest unit that keeps it at or above one (142 MB). */
  bytes: (bytes: number) => string
  /** A transfer rate (4.2 MB/s). */
  bytesPerSecond: (bytesPerSecond: number) => string
  /** Names joined with the language's own list punctuation. */
  list: (items: readonly string[]) => string
  /** How long ago, or "now" when under a minute. */
  relativeTime: (value: number, unit: RelativeUnit) => string
}

const BYTE_UNITS = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

export function createTranslator(language: Language, locale: string = language): Translator {
  const catalogue: Catalogue = CATALOGUES[language]
  const numberFormat = new Intl.NumberFormat(locale)
  const percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
  const listFormat = new Intl.ListFormat(locale, { style: 'narrow', type: 'conjunction' })
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const pluralRules = new Intl.PluralRules(language)

  function template(key: MessageKey, count = 0): string {
    const entry = catalogue[key]
    if (typeof entry === 'string') {
      return entry
    }
    // A key the catalogue does not carry shows as itself rather than taking the
    // window down; the catalogue gate and the on-screen-key check both fail on
    // it, so it cannot reach a release unnoticed.
    if (entry === undefined || entry === null) {
      return key
    }
    // A plural entry holds one form per CLDR category the language uses; the
    // catalogue gate guarantees the category the rules select is present.
    const forms = entry as Record<string, string>
    return forms[pluralRules.select(count)] ?? forms.other ?? key
  }

  function format(value: MessageValue): string {
    if (typeof value === 'number') return numberFormat.format(value)
    if (typeof value === 'string') return value
    return t(value.key, value.values)
  }

  function t(key: MessageKey, values?: MessageValues): string {
    const count = typeof values?.count === 'number' ? values.count : 0
    return template(key, count).replace(PLACEHOLDER, (whole, name: string) =>
      values !== undefined && name in values ? format(values[name]!) : whole,
    )
  }

  function sized(value: number, unit: string, perSecond: boolean): string {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: perSecond ? `${unit}-per-second` : unit,
      unitDisplay: 'short',
      maximumFractionDigits: value < 10 ? 1 : 0,
      minimumFractionDigits: value < 10 && unit !== 'byte' ? 1 : 0,
    }).format(value)
  }

  function bytes(count: number, perSecond = false): string {
    if (count < 1024) return sized(Math.round(count), 'byte', perSecond)
    let value = count / 1024
    let i = 0
    while (value >= 1024 && i < BYTE_UNITS.length - 1) {
      value /= 1024
      i++
    }
    return sized(value, BYTE_UNITS[i]!, perSecond)
  }

  return {
    language,
    locale,
    t,
    text: (message) => t(message.key, message.values),
    template,
    number: (value) => numberFormat.format(value),
    percent: (ratio) => percentFormat.format(ratio),
    bytes: (count) => bytes(count),
    bytesPerSecond: (count) => bytes(count, true),
    list: (items) => listFormat.format(items),
    relativeTime: (value, unit) => relativeFormat.format(-value, unit),
  }
}
