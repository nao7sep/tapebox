import { create } from 'zustand'
import type { Layout } from '@shared/layout'
import { ipcInvoke } from '@renderer/ipc/client'
import { presentFailure } from '@renderer/lib/presentFailure'

/**
 * Renderer-side mirror of persisted window geometry. It stays null until the
 * required app hydration commits, so a load rejection cannot turn defaults into
 * an apparently authoritative saved layout.
 */
export type LayoutField = keyof Layout

type LayoutState = {
  layout: Layout | null
  persistedLayout: Layout | null
  writeErrors: Partial<Record<LayoutField, string>>
  setHydratedLayout: (layout: Layout) => void
  setWriteError: (field: LayoutField, message: string | null) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  layout: null,
  persistedLayout: null,
  writeErrors: {},
  setHydratedLayout: (layout) => set({ layout, persistedLayout: layout, writeErrors: {} }),
  setWriteError: (field, message) => set((state) => {
    const writeErrors = { ...state.writeErrors }
    if (message === null) delete writeErrors[field]
    else writeErrors[field] = message
    return { writeErrors }
  }),
}))

const revisions: Partial<Record<LayoutField, number>> = {}

const FAILURE_COPY: Record<LayoutField, string> = {
  leftPaneWidth: 'The library pane size was not saved. Its previous size is back; try resizing it again.',
  chaptersPaneWidth: 'The chapters pane size was not saved. Its previous size is back; try resizing it again.',
  archiveBoxesHeight: 'The boxes pane size was not saved. Its previous size is back; try resizing it again.',
  volume: 'The playback volume was not saved. Its previous level is back; adjust it again.',
}

/**
 * Patch one or more geometry fields. persist=false updates the live intent for a
 * smooth drag. persist=true settles that field against main; current failures
 * roll back to the last confirmed value and remain visible at the field owner.
 */
export async function patchLayout(patch: Partial<Layout>, persist: boolean): Promise<void> {
  const state = useLayoutStore.getState()
  if (!state.layout || !state.persistedLayout) return
  const fields = Object.keys(patch) as LayoutField[]
  const versions = new Map<LayoutField, number>()
  for (const field of fields) {
    const next = (revisions[field] ?? 0) + 1
    revisions[field] = next
    versions.set(field, next)
  }
  useLayoutStore.setState({ layout: { ...state.layout, ...patch } })
  if (!persist) return

  for (const field of fields) useLayoutStore.getState().setWriteError(field, null)
  try {
    const confirmed = await ipcInvoke('layout:update', patch)
    const current = useLayoutStore.getState()
    if (!current.layout || !current.persistedLayout) return
    const confirmedPatch: Partial<Layout> = {}
    for (const field of fields) {
      if (revisions[field] === versions.get(field)) {
        Object.assign(confirmedPatch, { [field]: confirmed[field] })
      }
    }
    if (Object.keys(confirmedPatch).length > 0) {
      useLayoutStore.setState({
        layout: { ...current.layout, ...confirmedPatch },
        persistedLayout: { ...current.persistedLayout, ...confirmedPatch },
      })
    }
  } catch (error) {
    const current = useLayoutStore.getState()
    if (!current.layout || !current.persistedLayout) return
    const rollback: Partial<Layout> = {}
    for (const field of fields) {
      if (revisions[field] !== versions.get(field)) continue
      Object.assign(rollback, { [field]: current.persistedLayout[field] })
      useLayoutStore.getState().setWriteError(
        field,
        presentFailure(error, FAILURE_COPY[field], `${field} layout save failed`),
      )
    }
    if (Object.keys(rollback).length > 0) {
      useLayoutStore.setState({ layout: { ...useLayoutStore.getState().layout!, ...rollback } })
    }
  }
}
