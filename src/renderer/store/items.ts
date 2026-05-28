import { create } from 'zustand'
import type { Item } from '@shared/domain'

type ProgressEntry = { phase: 'probing' | 'downloading'; percent: number }

type ItemsState = {
  items: Item[]
  progress: Record<string, ProgressEntry | undefined>
  setAll: (items: Item[]) => void
  upsert: (item: Item) => void
  upsertMany: (items: Item[]) => void
  removeMany: (ids: string[]) => void
  setProgress: (itemId: string, entry: ProgressEntry) => void
  clearProgress: (itemId: string) => void
}

export const useItemsStore = create<ItemsState>((set) => ({
  items: [],
  progress: {},
  setAll: (items) => set({ items }),
  upsert: (item) => set((state) => {
    const idx = state.items.findIndex((i) => i.id === item.id)
    if (idx < 0) return { items: [...state.items, item] }
    const next = state.items.slice()
    next[idx] = item
    return { items: next }
  }),
  upsertMany: (items) => set((state) => {
    const byId = new Map(state.items.map((i) => [i.id, i]))
    for (const it of items) byId.set(it.id, it)
    return { items: Array.from(byId.values()) }
  }),
  removeMany: (ids) => set((state) => {
    const drop = new Set(ids)
    return { items: state.items.filter((i) => !drop.has(i.id)) }
  }),
  setProgress: (itemId, entry) => set((state) => ({
    progress: { ...state.progress, [itemId]: entry },
  })),
  clearProgress: (itemId) => set((state) => {
    const next = { ...state.progress }
    delete next[itemId]
    return { progress: next }
  }),
}))
