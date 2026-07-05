import { chmod, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { paths } from '@main/paths'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { utcTimestampForFilenameMs } from '@shared/utc'

/**
 * API key storage and resolution — the secret store at ~/.tapebox/api-keys.json,
 * separate from settings. This is the fleet api-key-storage-conventions realized
 * for tapebox.
 *
 * tapebox uses a single key today (`['openai']` → OPENAI_API_KEY, the
 * OpenAI-compatible endpoint), but the module is the generic, segment-addressed
 * form so its contract matches every other app in the fleet.
 *
 * Contract (api-key-storage-conventions):
 *   - A key id is its segments joined by '.', lowercase; its environment variable
 *     is the segments uppercased, joined by '_', suffixed '_API_KEY'. Stored ids
 *     are matched case-insensitively; non-conforming ids are ignored.
 *   - Resolution is source-first: every environment candidate (most→least
 *     specific) then every stored candidate. Environment wins; the more specific
 *     key wins within each source. `fallback: false` consults only the exact key.
 *     Every value is trimmed; blank counts as absent; an environment value is
 *     never written back.
 *   - The stored value is `obf:` + base64 of the reversed UTF-8 bytes; an untagged
 *     value is treated as plaintext. This is NOT encryption — the 0600 mode is the
 *     real protection. A marked value is validated as canonical base64 before
 *     decoding — never leniently decoded — so a malformed/hand-edited `obf:` value
 *     resolves to absent (warned, naming the key id) rather than a garbage "key".
 *   - On read: a group/world-readable file is warned about once and tightened to
 *     0600 (POSIX only); a corrupt/unreadable file is moved aside to a timestamped
 *     neighbour, warned, and treated as empty rather than throwing.
 */

const MARKER = 'obf:'
const SECRETS_FILE_MODE = 0o600
const ENFORCE_FILE_MODE = process.platform !== 'win32'

const SEGMENT_RE = /^[a-z0-9]+$/
const KEY_ID_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/

const SCHEMA = z.object({ keys: z.record(z.string(), z.string()) })
type ApiKeysFile = z.infer<typeof SCHEMA>

interface ResolveOptions {
  fallback?: boolean
}

// --- key id / env var derivation ---------------------------------------------

function assertSegments(segments: string[]): void {
  if (segments.length === 0 || !segments.every((s) => SEGMENT_RE.test(s))) {
    throw new Error(`Invalid api-key segments [${segments.join(', ')}]: each must match [a-z0-9]+`)
  }
}

// The prefixes of a segment list, most specific first: [a,b,c] → [[a,b,c],[a,b],[a]].
function prefixes(segments: string[]): string[][] {
  const out: string[][] = []
  for (let n = segments.length; n >= 1; n--) out.push(segments.slice(0, n))
  return out
}

function keyId(segments: string[]): string {
  return segments.join('.')
}

export function apiKeyEnvVar(segments: string[]): string {
  return `${segments.map((s) => s.toUpperCase()).join('_')}_API_KEY`
}

// --- obfuscation (NOT encryption) --------------------------------------------

function encodeApiKey(plain: string): string {
  return MARKER + Buffer.from(Buffer.from(plain, 'utf8')).reverse().toString('base64')
}

// Canonical base64 (RFC 4648, with padding): Buffer.from(str, 'base64') is lenient
// and silently decodes non-canonical input (stray characters, wrong length) into
// base64-derived garbage instead of throwing — exactly the malformed, hand-edited
// or corrupted `obf:` value we must not hand to a provider as a "key".
const CANONICAL_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

// Convention: an untagged value is plaintext, used as-is; a tagged value's payload
// must pass the canonical base64 shape check before it is decoded. Never throws —
// a value that fails the check is treated as absent (never leniently decoded) and
// warned once, naming the key id; an empty decode result is likewise absent, via
// the caller's existing trim/non-empty check.
function decodeApiKey(stored: string, id: string): string | null {
  if (!stored.startsWith(MARKER)) return stored
  const encoded = stored.slice(MARKER.length)
  if (encoded.length % 4 !== 0 || !CANONICAL_BASE64_RE.test(encoded)) {
    log.warn('stored api key is malformed (invalid obf: encoding); treating as absent', { id })
    return null
  }
  return Buffer.from(Buffer.from(encoded, 'base64')).reverse().toString('utf8')
}

// --- file read/write ---------------------------------------------------------

let modeWarned = false

async function warnIfInsecureMode(): Promise<void> {
  if (!ENFORCE_FILE_MODE || modeWarned) return
  try {
    const st = await stat(paths.apiKeys)
    if ((st.mode & 0o077) !== 0) {
      modeWarned = true
      log.warn('api key file is readable beyond the owner; tightening to 0600', {
        path: paths.apiKeys,
        mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
      })
      await chmod(paths.apiKeys, SECRETS_FILE_MODE).catch(() => {})
    }
  } catch {
    // No file yet, or stat failed — nothing to tighten.
  }
}

// Validate and canonicalize the on-disk shape: `{ keys: { id: value } }`, ids
// lowercased and matched against the id grammar, values kept only when strings.
function normalize(raw: unknown): ApiKeysFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { keys: {} }
  const rawKeys = (raw as { keys?: unknown }).keys
  if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) return { keys: {} }
  const keys: Record<string, string> = {}
  for (const [id, value] of Object.entries(rawKeys as Record<string, unknown>)) {
    const canonical = id.toLowerCase()
    if (typeof value === 'string' && KEY_ID_RE.test(canonical)) keys[canonical] = value
  }
  return { keys }
}

async function readAll(): Promise<ApiKeysFile> {
  await warnIfInsecureMode()
  let raw: unknown
  try {
    raw = await readJsonOptional(paths.apiKeys, z.unknown())
  } catch (err) {
    // Corrupt/unreadable: never fail key resolution over it. Move the bad file
    // aside (timestamped) so its bytes are preserved and it is handled once,
    // then degrade to "no key" — it is rebuilt on the next write.
    const quarantine = join(dirname(paths.apiKeys), `api-keys-${utcTimestampForFilenameMs()}.invalid`)
    try {
      await rename(paths.apiKeys, quarantine)
      log.warn('api-keys.json was unreadable; set aside and treating as empty', { path: paths.apiKeys, quarantine })
    } catch (asideErr) {
      log.warn('api-keys.json was unreadable and could not be set aside; treating as empty', {
        path: paths.apiKeys,
        error: (asideErr as Error)?.message ?? String(asideErr),
      })
    }
    return { keys: {} }
  }
  if (raw == null) return { keys: {} }
  return normalize(raw)
}

async function writeAll(data: ApiKeysFile): Promise<void> {
  await writeJsonAtomic(paths.apiKeys, data, SCHEMA, ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined)
}

function envValue(segments: string[]): string | null {
  const value = process.env[apiKeyEnvVar(segments)]?.trim()
  return value ? value : null
}

// --- public API --------------------------------------------------------------

/**
 * Resolve a key's plaintext value, source-first (environment then stored,
 * most→least specific), or null. `fallback: false` consults only the exact key.
 */
export async function resolveApiKey(segments: string[], options: ResolveOptions = {}): Promise<string | null> {
  assertSegments(segments)
  const levels = options.fallback === false ? [segments] : prefixes(segments)

  for (const level of levels) {
    const fromEnv = envValue(level)
    if (fromEnv) return fromEnv
  }
  const all = await readAll()
  for (const level of levels) {
    const id = keyId(level)
    const stored = all.keys[id]
    if (typeof stored === 'string') {
      const key = decodeApiKey(stored, id)?.trim()
      if (key) return key
    }
  }
  return null
}

/** Whether a key resolves from either the environment or the stored file. */
export async function hasApiKey(segments: string[], options: ResolveOptions = {}): Promise<boolean> {
  return (await resolveApiKey(segments, options)) !== null
}

/** Persist a key (trimmed, obfuscated). A blank key clears it instead. */
export async function writeApiKey(segments: string[], apiKey: string): Promise<void> {
  assertSegments(segments)
  const trimmed = apiKey.trim()
  const all = await readAll()
  if (trimmed.length === 0) {
    delete all.keys[keyId(segments)]
  } else {
    all.keys[keyId(segments)] = encodeApiKey(trimmed)
  }
  await writeAll(all)
}

/** Remove the stored key. Any environment value is unaffected. */
export async function clearApiKey(segments: string[]): Promise<void> {
  assertSegments(segments)
  const all = await readAll()
  if (keyId(segments) in all.keys) {
    delete all.keys[keyId(segments)]
    await writeAll(all)
  }
}
