import { create } from 'zustand'

/**
 * Which list keyboard navigation (Up/Down) currently drives. The app has three
 * selection-aware lists — the video list, the chapter list, and (in the archive)
 * the box list — and exactly one of them owns Up/Down at a time. Clicking inside a
 * list makes it active; selecting a tape or switching views returns to 'tapes', so
 * the keys are never dead. Each list's selection lives in its own store
 * (selection / archive) or is derived (the playing chapter); this flag is only the
 * cross-cutting "who has the arrows" router, kept here so no one feature store owns it.
 */
export type Panel = 'tapes' | 'chapters' | 'boxes'

type NavState = {
  activePanel: Panel
  setActivePanel: (panel: Panel) => void
}

export const useNavStore = create<NavState>((set) => ({
  activePanel: 'tapes',
  setActivePanel: (activePanel) => set({ activePanel }),
}))
