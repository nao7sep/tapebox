import { create } from 'zustand'
import type { Message } from '@shared/i18n/translate'

/**
 * Live yt-dlp output for in-progress (and just-failed) downloads, keyed by tape.
 * Newest entry first — the detail pane reads it top-down, so the latest line
 * (and, on failure, the error) sits at the top. Ephemeral: it mirrors what the
 * main process streams during an attempt, is reset when a new attempt starts,
 * and is dropped once the tape lands in the collection.
 */

// A line is yt-dlp's own output, shown as it printed it; an error is app copy.
export type LogEntry = { kind: 'line'; text: string } | { kind: 'error'; text: Message }

/** Bound per-tape history so a chatty or stuck download can't grow unbounded.
 *  Records keeps the run's complete output; the panel says when older lines left. */
export const MAX_LOG_ENTRIES = 300

type DownloadLogState = {
  entries: Record<string, LogEntry[]>
  /** Tapes whose live history has dropped its oldest lines. */
  trimmed: Record<string, true>
  prepend: (tapeId: string, entry: LogEntry) => void
  reset: (tapeId: string) => void
}

export const useDownloadLogStore = create<DownloadLogState>((set) => ({
  entries: {},
  trimmed: {},
  prepend: (tapeId, entry) =>
    set((state) => {
      const all = [entry, ...(state.entries[tapeId] ?? [])]
      const entries = { ...state.entries, [tapeId]: all.slice(0, MAX_LOG_ENTRIES) }
      if (all.length <= MAX_LOG_ENTRIES || state.trimmed[tapeId]) return { entries }
      return { entries, trimmed: { ...state.trimmed, [tapeId]: true } }
    }),
  reset: (tapeId) =>
    set((state) => {
      if (!state.entries[tapeId]) return state
      const entries = { ...state.entries }
      delete entries[tapeId]
      const trimmed = { ...state.trimmed }
      delete trimmed[tapeId]
      return { entries, trimmed }
    }),
}))
