import { create } from 'zustand'

type EnumState = {
  pending: { url: string; sourceTitle: string | null } | null
  open: (url: string, sourceTitle: string | null) => void
  close: () => void
}

/**
 * Pending playlist add. The modal mounts when this is set, takes ownership of
 * enum:start, and subscribes to its events BEFORE issuing the IPC call. Avoids
 * the race where main starts emitting events before the modal's useEffect runs.
 */
export const useEnumerationStore = create<EnumState>((set) => ({
  pending: null,
  open: (url, sourceTitle) => set({ pending: { url, sourceTitle } }),
  close: () => set({ pending: null }),
}))
