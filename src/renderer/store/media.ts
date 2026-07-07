import { create } from 'zustand'

/**
 * Base URL of the loopback media server, fetched once at app startup. Null
 * until hydrated; DetailPane builds a playable URL only once it is set.
 */
type MediaState = {
  baseUrl: string | null
  setBaseUrl: (baseUrl: string) => void
}

export const useMediaStore = create<MediaState>((set) => ({
  baseUrl: null,
  setBaseUrl: (baseUrl) => set({ baseUrl }),
}))
