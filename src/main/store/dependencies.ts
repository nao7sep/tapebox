import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { DependenciesSchema, defaultDependencies, type Dependencies } from '@shared/dependencies'

/**
 * Cache + atomic persistence for ~/.tapebox/dependencies.json — the recorded
 * managed-runtime-dependency facts, kept in their own store apart from the config
 * the user edits (persisted-store-separation-conventions).
 *
 * Facts semantics, deliberately unlike the config store:
 *   - Self-healing, never quarantined: a missing OR corrupt file falls back to
 *     fresh (all-null) entries, because every fact is re-derivable — a re-scan of
 *     disk plus one update check restores it. There is nothing to preserve, so no
 *     `.invalid` quarantine and no fail-loud (the opposite of the session store).
 *   - Written lazily: defaults are NOT materialized on first run. The file appears
 *     the first time a check or install has an actual fact to record — the
 *     convention's "facts are written only after the app learns them."
 *
 * mutateDependencies serializes read-modify-write the same way config does, because
 * two flows fold into these facts concurrently: the startup update-check (folding
 * every successful resolve) and a user-clicked install (folding one). A serialized
 * critical section keeps either from overwriting the other's fields with a stale
 * snapshot.
 */

let cache: Dependencies | null = null

export async function loadDependencies(): Promise<void> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(paths.dependencies, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt, not absent: the facts are re-derivable, so self-heal to defaults
      // (a re-check refills them) rather than quarantine-and-preserve as config does.
      log.warn('dependencies unreadable; using fresh facts', { error: describeError(err) })
    }
    cache = defaultDependencies()
    return
  }
  const parsed = DependenciesSchema.safeParse(raw)
  if (parsed.success) {
    cache = parsed.data
  } else {
    log.warn('dependencies invalid; using fresh facts', { error: describeError(parsed.error) })
    cache = defaultDependencies()
  }
}

export function getDependencies(): Dependencies {
  if (!cache) throw new Error('dependencies.ts: loadDependencies() must be awaited first')
  return cache
}

// Serializes all writes so the startup update-check and a user-clicked install
// can't clobber each other's per-binary facts with a stale snapshot — the same
// guard config.ts's writeChain provides for nested settings patches.
let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Atomically read-modify-write the recorded facts. The mutator runs inside a
 * serialized critical section against the *current* cache and returns a shallow
 * patch (one or more binary entries); omitted binaries keep their existing facts.
 */
export function mutateDependencies(
  mutator: (current: Dependencies) => Partial<Dependencies>,
): Promise<Dependencies> {
  const run = writeChain.then(async () => {
    if (!cache) throw new Error('dependencies.ts: loadDependencies() must be awaited first')
    const patch = mutator(cache)
    const merged = DependenciesSchema.parse({ ...cache, ...patch })
    cache = merged
    await writeManagedJson(paths.dependencies, merged, DependenciesSchema)
    log.info('dependencies updated', { keys: Object.keys(patch) })
    return merged
  })
  // Keep the chain alive even if one write rejects, so a failure can't wedge every
  // subsequent update.
  writeChain = run.then(() => undefined, () => undefined)
  return run
}
