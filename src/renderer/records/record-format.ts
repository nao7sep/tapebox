import type { MessageKey } from '@shared/i18n/catalogues'
import type { RecordCursor, RecordKind, RecordLevel, RecordLevelFilter, RecordsPage, RecordSummary } from '@shared/records'

/**
 * The Records window's pure decisions: how a record is named and keyed, how its
 * stored text is shown, where the next page starts, and how a re-read newest
 * page joins the rows already shown.
 */

export function recordKey(record: { kind: RecordKind; id: number }): string {
  return `${record.kind}:${record.id}`
}

/** Stored JSON, indented for reading; text that is not JSON is shown as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function holdsNothing(value: unknown): boolean {
  if (value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'object' && Object.keys(value).length === 0
}

/**
 * Stored JSON as a detail block's text, or null when it holds nothing to show
 * (`{}`, `null`, `[]`, or a blank string), so the block is left out. An
 * object's keys whose values equal what `shown` gives for them are left out
 * first, since the detail pane already shows them. Text that is not JSON is
 * kept as it is unless it is blank.
 */
export function jsonBlock(text: string, shown: Readonly<Record<string, unknown>> = {}): string | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return textBlock(text)
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    value = Object.fromEntries(Object.entries(value).filter(([key, field]) => !(key in shown && shown[key] === field)))
  }
  return holdsNothing(value) ? null : JSON.stringify(value, null, 2)
}

/** A tool's output as a detail block's text, or null when it is only whitespace. */
export function textBlock(text: string): string | null {
  return text.trim() === '' ? null : text
}

export function durationSeconds(startedAt: string, endedAt: string): number {
  return (Date.parse(endedAt) - Date.parse(startedAt)) / 1000
}

export const KIND_LABELS: Readonly<Record<RecordKind, MessageKey>> = {
  log: 'records.kindLog',
  'ai-call': 'records.kindAiCall',
  'ytdlp-run': 'records.kindYtdlpRun',
  'ffmpeg-run': 'records.kindFfmpegRun',
}

export const LEVEL_LABELS: Readonly<Record<RecordLevel, MessageKey>> = {
  error: 'records.levelError',
  warn: 'records.levelWarn',
  info: 'records.levelInfo',
  debug: 'records.levelDebug',
}

export const LEVEL_FILTER_LABELS: Readonly<Record<RecordLevelFilter, MessageKey>> = {
  attention: 'records.levelAttention',
  ...LEVEL_LABELS,
}

/** A level's text colour: the status hues for what needs attention, quiet otherwise. */
export const LEVEL_CLASSES: Readonly<Record<RecordLevel, string>> = {
  error: 'text-danger-fg',
  warn: 'text-warning-fg',
  info: 'text-fg-muted',
  debug: 'text-fg-muted',
}

/** The page after the last record shown. */
export function cursorAfter(records: readonly RecordSummary[]): RecordCursor | null {
  const last = records.at(-1)
  return last === undefined ? null : { time: last.time, kind: last.kind, id: last.id }
}

// The order the list shows records in, newest first; the database pages them
// the same way.
function newestFirst(a: RecordSummary, b: RecordSummary): number {
  if (a.time !== b.time) return a.time < b.time ? 1 : -1
  if (a.kind !== b.kind) return a.kind < b.kind ? 1 : -1
  return b.id - a.id
}

/**
 * The newest page read again, joined with the rows already shown: a row in both
 * takes the page's copy, and the rows shown beyond the page stay, so the pages
 * already read are kept and a page read out of order loses nothing.
 */
export function mergeNewestPage(
  shown: readonly RecordSummary[],
  shownMore: boolean,
  page: RecordsPage,
): { records: RecordSummary[]; more: boolean } {
  const byKey = new Map(shown.map((record) => [recordKey(record), record]))
  for (const record of page.records) byKey.set(recordKey(record), record)
  const records = [...byKey.values()].sort(newestFirst)
  const last = page.records.at(-1)
  const beyond = last !== undefined && shown.some((record) => newestFirst(record, last) > 0)
  return { records, more: beyond ? shownMore : page.more }
}

/** Within about one screen of the end of what is loaded. */
export function nearEnd(scroll: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= scroll.clientHeight
}

export function atTop(scroll: Pick<HTMLElement, 'scrollTop'>): boolean {
  return scroll.scrollTop < 1
}
