import { create } from 'zustand'

/**
 * Base URL of the loopback media server, fetched once at app startup. Null
 * until hydrated; DetailPane builds a playable URL only once it is set.
 */
type MediaState = {
  baseUrl: string | null
  collectionRevision: number
  setBaseUrl: (baseUrl: string) => void
}

export const useMediaStore = create<MediaState>((set) => ({
  baseUrl: null,
  collectionRevision: 0,
  setBaseUrl: (baseUrl) => set({ baseUrl }),
}))

/** Same-named files in another opened collection must have a new cache identity.
 * The server's process token already separates application launches. */
export function mediaFileUrl(media: Pick<MediaState, 'baseUrl' | 'collectionRevision'>, tapeId: string, filename: string | null): string | null {
  return media.baseUrl && filename
    ? `${media.baseUrl}/${tapeId}/${encodeURIComponent(filename)}?collection=${media.collectionRevision}`
    : null
}
