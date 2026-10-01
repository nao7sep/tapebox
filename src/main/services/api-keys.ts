import { chmod, stat } from 'node:fs/promises'
import { z } from 'zod'
import { paths } from '@main/paths'
import { quarantineFile, readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'

/**
 * API key storage and resolution — the secret store at ~/.tapebox/api-keys.json,
 * separate from settings. This is the fleet api-key-storage-conventions realized
 * for tapebox.
 *
 * tapebox uses a single key today (`'openai'` → OPENAI_API_KEY, the
 * OpenAI-compatible endpoint), but the module is the generic, id-addressed
 * form so its contract matches every other app in the fleet.
 *
 * Contract (api-key-storage-conventions):
 *   - A key id is one flat string of lowercase letters, digits, and dots
 *     (`openai`, `openai.image`); its environment variable is the id uppercased,
 *     dots to underscores, suffixed '_API_KEY'. Stored ids are matched
 *     case-insensitively; non-conforming ids are ignored.
 *   - Resolution consults exactly two places for the EXACT id: the environment
 *     variable, then the stored value. There is no fallback from a longer id
 *     (`openai.image`) to a shorter one (`openai`). Every value is trimmed; blank
 *     counts as absent; an environment value is never written back.
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

const KEY_ID_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/

const SCHEMA = z.object({ keys: z.record(z.string(), z.string()) })
type ApiKeysFile = z.infer<typeof SCHEMA>

// --- key id / env var derivation ---------------------------------------------

function assertKeyId(id: string): void {
  if (!KEY_ID_RE.test(id)) {
    throw new Error(`Invalid api-key id '${id}': must match ${KEY_ID_RE}`)
  }
}

export function apiKeyEnvVar(id: string): string {
  return `${id.toUpperCase().replaceAll('.', '_')}_API_KEY`
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
    try {
      const quarantine = await quarantineFile(paths.apiKeys)
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
  // not recorded: api-keys.json is a SECRET store and is never written through the
  // managed-text choke point. A backup history that held a credential would become
  // sensitive-at-rest in its entirety (data-backup conventions: secrets are never
  // recorded); the live file keeps its own 0600 at-rest protection here instead.
  await writeJsonAtomic(paths.apiKeys, data, SCHEMA, ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined)
}

function envValue(id: string): string | null {
  const value = process.env[apiKeyEnvVar(id)]?.trim()
  return value ? value : null
}

// --- public API --------------------------------------------------------------

/**
 * Resolve a key's plaintext value for the exact id — the environment variable,
 * then the stored value — or null. There is no fallback to any other id.
 */
export async function resolveApiKey(id: string): Promise<string | null> {
  assertKeyId(id)

  const fromEnv = envValue(id)
  if (fromEnv) return fromEnv

  const all = await readAll()
  const stored = all.keys[id]
  if (typeof stored === 'string') {
    const key = decodeApiKey(stored, id)?.trim()
    if (key) return key
  }
  return null
}

/** Whether a key resolves from either the environment or the stored file. */
export async function hasApiKey(id: string): Promise<boolean> {
  return (await resolveApiKey(id)) !== null
}

/** Persist a key (trimmed, obfuscated). A blank key clears it instead. */
export async function writeApiKey(id: string, apiKey: string): Promise<void> {
  assertKeyId(id)
  const trimmed = apiKey.trim()
  const all = await readAll()
  if (trimmed.length === 0) {
    delete all.keys[id]
  } else {
    all.keys[id] = encodeApiKey(trimmed)
  }
  await writeAll(all)
}

/** Remove the stored key. Any environment value is unaffected. */
export async function clearApiKey(id: string): Promise<void> {
  assertKeyId(id)
  const all = await readAll()
  if (id in all.keys) {
    delete all.keys[id]
    await writeAll(all)
  }
}
