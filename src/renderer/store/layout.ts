import { create } from 'zustand'
import { type Layout, defaultLayout } from '@shared/layout'
import { ipcInvoke } from '@renderer/ipc/client'

/**
 * Renderer-side mirror of the persisted window geometry, hydrated once at
 * startup. Seeded with defaults (never null) so consumers read a size
 * synchronously without a fallback at every call site.
 */
type LayoutState = {
  layout: Layout
  setLayout: (layout: Layout) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  layout: defaultLayout,
  setLayout: (layout) => set({ layout }),
}))

/**
 * Patch one or more geometry fields. persist=false updates only the in-memory
 * mirror — used for smooth live dragging without a disk write per pixel.
 * persist=true also saves via layout:update (the main store debounces the write
 * and merges, so omitting other fields never clobbers them).
 */
export function patchLayout(patch: Partial<Layout>, persist: boolean): void {
  const cur = useLayoutStore.getState().layout
  useLayoutStore.getState().setLayout({ ...cur, ...patch })
  if (persist) {
    void ipcInvoke('layout:update', patch).then((l) => useLayoutStore.getState().setLayout(l))
  }
}
