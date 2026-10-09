import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { FORMAT_VERSIONS, parseStoreJson } from '@main/io/format-version'
import { describeError } from '@shared/error'
import { LayoutSchema, defaultLayout, type Layout } from '@shared/layout'

/**
 * In-memory view-state cache + debounced atomic persistence to layout.json.
 * Self-healing on load (a missing or invalid file falls back to defaults)
 * because it holds no data worth protecting — the opposite policy from the
 * session store. A file in a newer format is left as it is: the defaults are
 * used and nothing is written for the session. Writes are debounced so rapid updates collapse into one write.
 */

const SAVE_DEBOUNCE_MS = 500

let cache: Layout = { ...defaultLayout }
let saveTimer: NodeJS.Timeout | null = null
let writeQueue: Promise<void> = Promise.resolve()
/** True when layout.json is in a newer format, which this build never writes. */
let newerOnDisk = false
/** What layout.json last held as read or written, so an unchanged save writes
 *  nothing and leaves its modified time alone (content-lifecycle conventions). */
let lastWritten: string | null = null

export async function loadLayout(): Promise<void> {
  cache = { ...defaultLayout }
  newerOnDisk = false
  lastWritten = null
  let text: string
  try {
    text = await readFile(paths.layout, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('layout unreadable; using defaults', { error: describeError(err) })
    }
    return
  }
  const found = parseStoreJson(text, FORMAT_VERSIONS.layout, true)
  if (found.status === 'newer') {
    // Intact, from a newer build: used as defaults and never written this session.
    newerOnDisk = true
    log.warn('layout is from a newer TapeBox; using defaults and leaving it as it is', {
      path: paths.layout,
      formatVersion: found.version,
    })
    return
  }
  const parsed = found.status === 'read' ? LayoutSchema.safeParse(found.value) : null
  if (parsed?.success) {
    cache = parsed.data
    if (found.status === 'read' && found.version === FORMAT_VERSIONS.layout) lastWritten = JSON.stringify(cache)
  } else {
    const error = found.status === 'unreadable' ? found.error : parsed?.error
    log.warn('layout invalid; using defaults', { error: describeError(error) })
  }
}

export function getLayout(): Layout {
  return cache
}

export function updateLayout(patch: Partial<Layout>): Layout {
  cache = LayoutSchema.parse({ ...cache, ...patch })
  scheduleSave()
  return cache
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void persistNow() }, SAVE_DEBOUNCE_MS)
}

/** Flush pending writes. Called on app quit; also safe to call any time. */
export async function persistNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (newerOnDisk) return
  const write = writeQueue.then(async () => {
    // Snapshot inside the serialized turn so a newer cache always wins after an
    // older in-flight write. Overlapping renderer updates must not race.
    const snapshot = structuredClone(cache)
    const key = JSON.stringify(snapshot)
    if (key === lastWritten) return
    // layout.json is volatile state only (pane sizes, volume): the raw atomic
    // writer saves it without recording to the backup history.
    await writeJsonAtomic(paths.layout, snapshot, { formatVersion: FORMAT_VERSIONS.layout, schema: LayoutSchema })
    lastWritten = key
  })
  writeQueue = write.catch(() => {})
  try { await write } catch (err) {
    log.error('layout persist failed', { error: describeError(err) })
  }
}
