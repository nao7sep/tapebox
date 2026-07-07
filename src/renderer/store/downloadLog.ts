import { create } from 'zustand'

/**
 * Live yt-dlp output for in-progress (and just-failed) downloads, keyed by tape.
 * Newest entry first — the detail pane reads it top-down, so the latest line
 * (and, on failure, the error) sits at the top. Ephemeral: it mirrors what the
 * main process streams during an attempt, is reset when a new attempt starts,
 * and is dropped once the tape lands in the library.
 */

export type LogEntry = { kind: 'line' | 'error'; text: string }

/** Bound per-tape history so a chatty or stuck download can't grow unbounded. */
const MAX_ENTRIES = 300

type DownloadLogState = {
  entries: Record<string, LogEntry[]>
  prepend: (tapeId: string, entry: LogEntry) => void
  reset: (tapeId: string) => void
}

export const useDownloadLogStore = create<DownloadLogState>((set) => ({
  entries: {},
  prepend: (tapeId, entry) =>
    set((state) => {
      const next = [entry, ...(state.entries[tapeId] ?? [])].slice(0, MAX_ENTRIES)
      return { entries: { ...state.entries, [tapeId]: next } }
    }),
  reset: (tapeId) =>
    set((state) => {
      if (!state.entries[tapeId]) return state
      const next = { ...state.entries }
      delete next[tapeId]
      return { entries: next }
    }),
}))
