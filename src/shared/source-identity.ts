import type { Tape } from './domain'
import { canonicalizeForDedup } from './url'

/**
 * The one rule for "is this video already in the library?", used by Add, import,
 * page scans and the post-probe duplicate check.
 *
 * Two sources are the same video when their URLs match once tracking parameters and
 * the fragment are dropped (canonicalizeForDedup), or when both know yt-dlp's
 * (extractor, id) pair and it matches. A bare id never matches on its own: yt-dlp
 * ids are unique only within an extractor. Extractor names compare
 * case-insensitively, since yt-dlp spells the same extractor `youtube` in a probe
 * and `Youtube` (its key) in a page listing.
 */
export type SourceRef = {
  url: string
  extractor?: string | null
  sourceId?: string | null
}

function idKey(ref: SourceRef): string | null {
  if (!ref.extractor || !ref.sourceId) return null
  return `${ref.extractor.toLowerCase()}\u0000${ref.sourceId}`
}

export function tapeSourceRef(tape: Tape): SourceRef {
  return { url: tape.sourceUrl, extractor: tape.extractor, sourceId: tape.sourceId }
}

/** A lookup of known sources, each naming the entry it came from. */
export class SourceIndex {
  private readonly byUrl = new Map<string, string>()
  private readonly byId = new Map<string, string>()

  /** Record `ref` as belonging to `owner` (a tape id, or any label the caller needs back). */
  add(ref: SourceRef, owner: string): void {
    const url = canonicalizeForDedup(ref.url)
    if (!this.byUrl.has(url)) this.byUrl.set(url, owner)
    const id = idKey(ref)
    if (id !== null && !this.byId.has(id)) this.byId.set(id, owner)
  }

  /** The owner of a known source that is the same video as `ref`, if any. */
  find(ref: SourceRef): string | undefined {
    const id = idKey(ref)
    return this.byUrl.get(canonicalizeForDedup(ref.url)) ?? (id === null ? undefined : this.byId.get(id))
  }

  has(ref: SourceRef): boolean {
    return this.find(ref) !== undefined
  }
}

/** Index every tape's source by its tape id, leaving out `exceptId` (a tape checking against the rest). */
export function librarySourceIndex(tapes: readonly Tape[], exceptId?: string): SourceIndex {
  const index = new SourceIndex()
  for (const tape of tapes) {
    if (tape.id !== exceptId) index.add(tapeSourceRef(tape), tape.id)
  }
  return index
}
