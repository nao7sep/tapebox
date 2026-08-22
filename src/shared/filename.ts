/** Portable directory-entry identity for names the app assigns or compares.
 * macOS treats canonically equivalent Unicode spellings as one entry, while the
 * fleet also refuses case-only siblings so files remain portable to Windows. */
export function portableFilenameIdentity(name: string): string {
  return name.normalize('NFC').toLowerCase()
}
