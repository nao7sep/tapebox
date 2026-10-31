/**
 * What the Records window reads from records.sqlite3 (io/records.ts): a filtered
 * page of summaries, newest first, and one record detail. Tool output is paged;
 * other stored JSON text arrives whole for the window to format.
 */

/** One per table: log lines, AI calls, yt-dlp runs and ffmpeg runs. */
export const RECORD_KINDS = ['log', 'ai-call', 'ytdlp-run', 'ffmpeg-run'] as const

export type RecordKind = (typeof RECORD_KINDS)[number]

export const RECORD_LEVELS = ['error', 'warn', 'info', 'debug'] as const

export type RecordLevel = (typeof RECORD_LEVELS)[number]

/**
 * What the level filter offers: a record's own level, or `warningsAndErrors`, every
 * record at `warn` or `error`, labelled "Warnings and errors": a recovered
 * problem need not mean outstanding work (logging-conventions). Only a log line has a level of its own; an AI call
 * reads as `error` when it failed. A yt-dlp or ffmpeg run reads as `warn` when the
 * user cancelled it or TapeBox quit during it, `info` when it succeeded, and
 * `error` otherwise, including a run a signal ended for any other reason.
 */
export const RECORD_LEVEL_FILTERS = ['warningsAndErrors', ...RECORD_LEVELS] as const

export type RecordLevelFilter = (typeof RECORD_LEVEL_FILTERS)[number]

/**
 * Why TapeBox ended a yt-dlp or ffmpeg run early, as it knew when the run ended:
 * the user cancelled it, TapeBox was quitting, or the run wrote nothing for longer
 * than its idle bound. A run TapeBox did not end early stores none.
 */
export const RUN_STOPS = ['cancel', 'quit', 'idle'] as const

export type RunStop = (typeof RUN_STOPS)[number]

/** Where the next page starts: the last summary of the page before it. */
export type RecordCursor = {
  time: string
  kind: RecordKind
  id: number
}

export type RecordsQuery = {
  /** A launch, named by its session. */
  session: string | null
  kind: RecordKind | null
  level: RecordLevelFilter | null
  tapeId: string | null
  search: string
  after: RecordCursor | null
}

export type RecordSummary = {
  kind: RecordKind
  id: number
  session: string
  /** A log line's time, or when a call or run started. */
  time: string
  level: RecordLevel
  /** A log line's message, an AI call's model, or a run's tool and kind. */
  title: string
  /** An AI call's endpoint, or a yt-dlp run's URL. */
  text: string | null
  tapeId: string | null
}

export type RecordsPage = {
  records: RecordSummary[]
  more: boolean
}

export type LogRecordDetail = {
  kind: 'log'
  id: number
  session: string
  time: string
  level: RecordLevel
  message: string
  tapeId: string | null
  fields: string
}

export type AiCallRecordDetail = {
  kind: 'ai-call'
  id: number
  session: string
  tapeId: string | null
  startedAt: string
  endedAt: string
  /** Measured monotonic execution time, or unknown for historical records. */
  elapsedMs: number | null
  level: RecordLevel
  endpoint: string
  model: string
  request: string | null
  status: number | null
  response: string | null
  error: string | null
}

export type YtdlpRunRecordDetail = {
  kind: 'ytdlp-run'
  id: number
  session: string
  tapeId: string | null
  scanId: string | null
  /** What the run was for: download, scan, probe or thumbnail. */
  run: string
  url: string
  args: string
  startedAt: string
  endedAt: string
  /** Measured monotonic execution time, or unknown for historical records. */
  elapsedMs: number | null
  level: RecordLevel
  exitCode: number | null
  signal: string | null
  stopReason: RunStop | null
  stdout: string
  stderr: string
  outputStatus: 'complete' | 'incomplete' | 'unknown'
  stdoutMore: boolean
  stderrMore: boolean
}

export type FfmpegRunRecordDetail = {
  kind: 'ffmpeg-run'
  id: number
  session: string
  tapeId: string | null
  /** What the run was for: probe or thumbnail. */
  run: string
  args: string
  startedAt: string
  endedAt: string
  /** Measured monotonic execution time, or unknown for historical records. */
  elapsedMs: number | null
  level: RecordLevel
  exitCode: number | null
  signal: string | null
  stopReason: RunStop | null
  stdout: string
  stderr: string
  outputStatus: 'complete' | 'incomplete' | 'unknown'
  stdoutMore: boolean
  stderrMore: boolean
}

export type RecordDetail = LogRecordDetail | AiCallRecordDetail | YtdlpRunRecordDetail | FfmpegRunRecordDetail

/** The values the filters offer: every launch and every tape that has records. */
export type RecordSources = {
  currentSession: string | null
  sessions: string[]
  /** A tape still in the collection carries its title. */
  tapes: { tapeId: string; name: string | null }[]
}


export type RunOutputQuery = {
  kind: 'ytdlp-run' | 'ffmpeg-run'
  id: number
  stream: 'stdout' | 'stderr'
  page: number
}

/** One bounded output page, without retaining preceding pages. */
export type RunOutputPage = { text: string; more: boolean }
