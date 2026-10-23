import type { MessageKey } from '@shared/i18n/catalogues'
import type {
  RecordCursor,
  RecordKind,
  RecordLevel,
  RecordLevelFilter,
  RecordSummary,
  RunStop,
} from '@shared/records'

/**
 * The Records window's pure decisions: how a record is named and keyed, how its
 * stored text is shown and where the next page starts.
 */

export function recordKey(record: { kind: RecordKind; id: number }): string {
  return `${record.kind}:${record.id}`
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

export const RUN_STOP_LABELS: Readonly<Record<RunStop, MessageKey>> = {
  cancel: 'records.stopCancel',
  quit: 'records.stopQuit',
  idle: 'records.stopIdle',
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

/** Within about one screen of the end of what is loaded. */
export function nearEnd(scroll: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= scroll.clientHeight
}

export function atTop(scroll: Pick<HTMLElement, 'scrollTop'>): boolean {
  return scroll.scrollTop < 1
}
