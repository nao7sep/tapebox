import { open, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { paths } from '@main/paths'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { FORMAT_VERSIONS, parseStoreJson } from '@main/io/format-version'
import { log } from '@main/io/logger'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'
import { describeError } from '@shared/error'

/**
 * API key storage and resolution — the secret store at ~/.tapebox/api-keys.json,
 * separate from settings. This is the fleet api-key-storage-conventions realized
 * for tapebox.
 *
 * tapebox uses a single key today (`'openai'` → OPENAI_API_KEY, sent to the
 * OpenAI endpoint or a local server), but the module is the generic, id-addressed
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
 *     0600 (POSIX only); a file that cannot be read or parsed is warned about,
 *     left in place and treated as empty, and the next key change replaces it. A
 *     file in a newer format is left as it is and treated as empty, and a change
 *     to it is refused (store-recovery-conventions).
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

async function warnIfInsecureMode(file: FileHandle): Promise<void> {
  if (!ENFORCE_FILE_MODE) return
  try {
    const st = await file.stat()
    if ((st.mode & 0o077) !== 0) {
      if (!modeWarned) {
        modeWarned = true
        log.warn('api key file is readable beyond the owner; tightening to 0600', {
          path: paths.apiKeys,
          mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
        })
      }
      await file.chmod(SECRETS_FILE_MODE)
    }
  } catch (error) {
    log.warn('api key file permissions could not be tightened', { error: describeError(error) })
  }
}

// Validate and canonicalize the on-disk shape: `{ keys: { id: value } }`, ids
// lowercased and matched against the id grammar, values kept only when strings.
function normalize(raw: unknown): ApiKeysFile | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rawKeys = (raw as { keys?: unknown }).keys
  if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) return null
  const keys: Record<string, string> = {}
  for (const [id, value] of Object.entries(rawKeys as Record<string, unknown>)) {
    const canonical = id.toLowerCase()
    if (!KEY_ID_RE.test(canonical)) continue
    if (typeof value !== 'string' || decodeApiKey(value, canonical) === null) return null
    keys[canonical] = value
  }
  return { keys }
}

/** The stored keys; `newer` when api-keys.json is in a newer format, intact;
 *  `unreadable` when it could not be read or parsed. Either way no key resolves
 *  from it and it is left exactly as it is (store-recovery-conventions). */
type KeyRead = ApiKeysFile | 'newer' | 'unreadable'

async function readAll(): Promise<KeyRead> {
  let file: FileHandle | undefined
  try {
    let text: string
    try {
      file = await open(paths.apiKeys, 'r')
      text = await file.readFile('utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { keys: {} }
      log.warn('api-keys.json could not be read; no key resolves from it and it is left in place', {
        path: paths.apiKeys,
        error: describeError(err),
      })
      return 'unreadable'
    }
    const found = parseStoreJson(text, FORMAT_VERSIONS.apiKeys, true)
    if (found.status === 'newer') {
      log.warn('api-keys.json is from a newer TapeBox; treating it as empty and leaving it as it is', {
        path: paths.apiKeys,
        formatVersion: found.version,
      })
      return 'newer'
    }
    const normalized = found.status === 'read' ? normalize(found.value) : null
    if (!normalized) {
      log.warn('api-keys.json is malformed; no key resolves from it and it is left in place', { path: paths.apiKeys })
      return 'unreadable'
    }
    await warnIfInsecureMode(file)
    return normalized
  } finally {
    if (file) await closeKeyFile(file)
  }
}

async function closeKeyFile(file: FileHandle): Promise<void> {
  try { await file.close() } catch (error) {
    log.warn('api key file did not close cleanly', { error: describeError(error) })
  }
}

/** The stored keys for a change. A file in a newer format, which this build never
 *  writes, refuses it; an unreadable one is replaced (`replace`), since entering
 *  or clearing a key is the user's way past it. */
async function readAllForWrite(): Promise<{ all: ApiKeysFile; replace: boolean }> {
  const all = await readAll()
  if (all === 'newer') {
    throw new UserFacingError('conflict', message('errors.fileNewer', { name: basename(paths.apiKeys) }))
  }
  return all === 'unreadable' ? { all: { keys: {} }, replace: true } : { all, replace: false }
}

async function writeAll(data: ApiKeysFile): Promise<void> {
  // not recorded: api-keys.json is a SECRET store and is never written through the
  // managed-text choke point. A backup history that held a credential would become
  // sensitive-at-rest in its entirety (data-backup conventions: secrets are never
  // recorded); the live file keeps its own 0600 at-rest protection here instead.
  await writeJsonAtomic(paths.apiKeys, data, {
    formatVersion: FORMAT_VERSIONS.apiKeys,
    schema: SCHEMA,
    mode: ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined,
  })
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
  const stored = typeof all === 'string' ? undefined : all.keys[id]
  if (typeof stored === 'string') {
    const key = decodeApiKey(stored, id)?.trim()
    if (key) return key
  }
  return null
}

/** What Settings shows for a key: set (from the environment or the file),
 *  absent, or stored in a file this build cannot use. */
export type ApiKeyState = 'set' | 'absent' | 'unreadable' | 'newer'

export async function apiKeyState(id: string): Promise<ApiKeyState> {
  if ((await resolveApiKey(id)) !== null) return 'set'
  const all = await readAll()
  return typeof all === 'string' ? all : 'absent'
}

/** Persist a key (trimmed, obfuscated). A blank key clears it instead. */
export async function writeApiKey(id: string, apiKey: string): Promise<void> {
  assertKeyId(id)
  const trimmed = apiKey.trim()
  const { all, replace } = await readAllForWrite()
  const encoded = trimmed.length === 0 ? undefined : encodeApiKey(trimmed)
  // The same key saved again changes nothing on disk (content-lifecycle conventions).
  if (!replace && all.keys[id] === encoded) return
  if (encoded === undefined) delete all.keys[id]
  else all.keys[id] = encoded
  await writeAll(all)
}

/** Remove the stored key. Any environment value is unaffected. */
export async function clearApiKey(id: string): Promise<void> {
  assertKeyId(id)
  const { all, replace } = await readAllForWrite()
  if (replace || id in all.keys) {
    delete all.keys[id]
    await writeAll(all)
  }
}
