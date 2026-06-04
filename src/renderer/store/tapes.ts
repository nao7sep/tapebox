import { create } from 'zustand'
import type { Tape } from '@shared/domain'

type ProgressEntry = { phase: 'probing' | 'downloading'; percent: number }

type TapesState = {
  tapes: Tape[]
  progress: Record<string, ProgressEntry | undefined>
  setAll: (tapes: Tape[]) => void
  upsert: (tape: Tape) => void
  upsertMany: (tapes: Tape[]) => void
  removeMany: (ids: string[]) => void
  setProgress: (tapeId: string, entry: ProgressEntry) => void
  clearProgress: (tapeId: string) => void
}

export const useTapesStore = create<TapesState>((set) => ({
  tapes: [],
  progress: {},
  setAll: (tapes) => set({ tapes }),
  upsert: (tape) => set((state) => {
    const idx = state.tapes.findIndex((i) => i.id === tape.id)
    if (idx < 0) return { tapes: [...state.tapes, tape] }
    const next = state.tapes.slice()
    next[idx] = tape
    return { tapes: next }
  }),
  upsertMany: (tapes) => set((state) => {
    const byId = new Map(state.tapes.map((i) => [i.id, i]))
    for (const it of tapes) byId.set(it.id, it)
    return { tapes: Array.from(byId.values()) }
  }),
  removeMany: (ids) => set((state) => {
    const drop = new Set(ids)
    return { tapes: state.tapes.filter((i) => !drop.has(i.id)) }
  }),
  setProgress: (tapeId, entry) => set((state) => ({
    progress: { ...state.progress, [tapeId]: entry },
  })),
  clearProgress: (tapeId) => set((state) => {
    const next = { ...state.progress }
    delete next[tapeId]
    return { progress: next }
  }),
}))
