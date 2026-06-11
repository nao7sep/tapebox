import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'

/**
 * Reserve an unused on-disk stem for a new tape's files.
 *
 * A downloaded tape's media, sidecar, and thumbnail all share one stem — the
 * tape's own nanoid id — so the on-disk name is opaque, stable, and (unlike the
 * source's video id) globally unique by construction rather than by assumption.
 * The sidecar is the one file whose extension is fixed (`.json`), so a free
 * `{stem}.json` means the whole `{stem}.*` namespace is ours. A nanoid collision
 * is astronomically unlikely, but checking makes reuse impossible rather than
 * merely improbable — and guards against a leftover file from a tape removed
 * with "keep files".
 */

const STEM_LENGTH = 10

export async function reserveStem(libraryDir: string): Promise<string> {
  for (;;) {
    const stem = nanoid(STEM_LENGTH)
    if (!(await exists(join(libraryDir, `${stem}.json`)))) return stem
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
