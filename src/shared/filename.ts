/** Portable directory-entry identity for names the app assigns or compares.
 * macOS treats canonically equivalent Unicode spellings as one entry, while the
 * fleet also refuses case-only siblings so files remain portable to Windows. */
export function portableFilenameIdentity(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** The first bundle member that aliases an earlier portable filename. */
export function collidingPortableFilename(names: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const name of names) {
    const identity = portableFilenameIdentity(name)
    if (seen.has(identity)) return name
    seen.add(identity)
  }
  return undefined
}

/** Identity shared by live box admission and catalog decoding. */
export const normalizeBoxName = (name: string): string => name.normalize("NFC").trim()
export const boxNameIdentity = (name: string): string => normalizeBoxName(name).toLowerCase()
