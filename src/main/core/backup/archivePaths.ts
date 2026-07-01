/**
 * Pure mapping from a file's role to its entry path within the archive. TapeBox is home-root-only (see
 * the data-backup conventions): every backed-up file lives under `~/.tapebox/`, so its path relative to
 * the root is mirrored straight onto the archive root (`config.json` → `config.json`). All entry paths
 * use forward slashes.
 */

/** Normalizes a filesystem-relative path to a forward-slash archive path. */
export function normalize(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** A file directly under `~/.tapebox/`: its relative path is the archive path (`catalog.json`). */
export function forHomeFile(relativePath: string): string {
  return normalize(relativePath)
}
