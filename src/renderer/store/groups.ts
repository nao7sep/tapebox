import { create } from 'zustand'
import type { ArchiveGroup } from '@shared/domain'

/**
 * Renderer mirror of the archive boxes, hydrated at startup and kept in sync by
 * the groups:changed event. Box membership and order of individual tapes live on
 * the items themselves (see itemOrder); this store is just the box list.
 */
type GroupsState = {
  groups: ArchiveGroup[]
  setGroups: (groups: ArchiveGroup[]) => void
}

export const useGroupsStore = create<GroupsState>((set) => ({
  groups: [],
  setGroups: (groups) => set({ groups }),
}))
