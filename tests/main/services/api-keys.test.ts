import { mkdtempSync, statSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// api-keys.ts resolves its file path from TAPEBOX_HOME (paths.ts), so the override
// must be set BEFORE the module is imported. Point the storage root at a throwaway
// temp dir — the override is the one path-relocation seam, the same way tests and
// production relocate the root (storage-path-conventions).
const root = mkdtempSync(join(tmpdir(), 'tapebox-apikeys-'))
const prevHome = process.env.TAPEBOX_HOME
process.env.TAPEBOX_HOME = root

const apiKeys = await import('@main/services/api-keys')
const apiKeysPath = join(root, 'api-keys.json')

const ENFORCE_MODE = process.platform !== 'win32'
const OPENAI = apiKeys.apiKeyEnvVar(['openai']) // 'OPENAI_API_KEY'

function clearOpenAiEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (/^OPENAI.*_API_KEY$/.test(name)) delete process.env[name]
  }
}

beforeEach(() => {
  clearOpenAiEnv()
})

afterEach(async () => {
  // Reset the stored key between tests so each starts from a known state.
  await apiKeys.clearApiKey(['openai']).catch(() => {})
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.TAPEBOX_HOME
  else process.env.TAPEBOX_HOME = prevHome
  clearOpenAiEnv()
})

describe('api-keys storage', () => {
  it('derives the conventional environment variable from the segments', () => {
    expect(OPENAI).toBe('OPENAI_API_KEY')
  })

  it('round-trips a stored key', async () => {
    await apiKeys.writeApiKey(['openai'], 'sk-stored-123')
    expect(await apiKeys.hasApiKey(['openai'])).toBe(true)
    expect(await apiKeys.resolveApiKey(['openai'])).toBe('sk-stored-123')
  })

  it('stores the key under its segment id, obfuscated (not plain text)', async () => {
    await apiKeys.writeApiKey(['openai'], 'sk-plaintext-secret')
    const onDisk = await readFile(apiKeysPath, 'utf8')
    expect(onDisk).not.toContain('sk-plaintext-secret')
    expect(JSON.parse(onDisk)).toHaveProperty(['keys', 'openai'])
  })

  it('clears the stored key', async () => {
    await apiKeys.writeApiKey(['openai'], 'sk-stored-123')
    await apiKeys.clearApiKey(['openai'])
    expect(await apiKeys.hasApiKey(['openai'])).toBe(false)
    expect(await apiKeys.resolveApiKey(['openai'])).toBeNull()
  })

  it('prefers OPENAI_API_KEY over the stored value and trims it', async () => {
    await apiKeys.writeApiKey(['openai'], 'sk-stored-123')
    process.env[OPENAI] = '  sk-from-env  '
    expect(await apiKeys.resolveApiKey(['openai'])).toBe('sk-from-env')
    expect(await apiKeys.hasApiKey(['openai'])).toBe(true)
  })

  it('reports a key present from the environment even with nothing stored', async () => {
    process.env[OPENAI] = 'sk-from-env-only'
    expect(await apiKeys.hasApiKey(['openai'])).toBe(true)
    expect(await apiKeys.resolveApiKey(['openai'])).toBe('sk-from-env-only')
  })

  it('ignores a blank/whitespace-only environment key and falls back to the stored value', async () => {
    await apiKeys.writeApiKey(['openai'], 'sk-stored-123')
    process.env[OPENAI] = '   '
    expect(await apiKeys.resolveApiKey(['openai'])).toBe('sk-stored-123')
  })

  it('treats an untagged stored value as plaintext and trims it', async () => {
    await writeFile(apiKeysPath, JSON.stringify({ keys: { openai: '  sk-plain-pasted  ' } }), 'utf8')
    expect(await apiKeys.resolveApiKey(['openai'])).toBe('sk-plain-pasted')
  })

  it('matches stored key ids case-insensitively', async () => {
    await writeFile(apiKeysPath, JSON.stringify({ keys: { OpenAI: 'sk-case' } }), 'utf8')
    expect(await apiKeys.resolveApiKey(['openai'])).toBe('sk-case')
  })

  it('resolves source-first with most-to-least-specific fallback', async () => {
    await apiKeys.writeApiKey(['openai'], 'general-stored')
    await apiKeys.writeApiKey(['openai', 'slug'], 'slug-stored')

    // A more specific stored key beats the general stored key.
    expect(await apiKeys.resolveApiKey(['openai', 'slug'])).toBe('slug-stored')
    // An unconfigured specific key falls back to the general stored key.
    expect(await apiKeys.resolveApiKey(['openai', 'other'])).toBe('general-stored')

    // Source-first: a general env beats even a more specific stored key.
    process.env[OPENAI] = 'general-env'
    expect(await apiKeys.resolveApiKey(['openai', 'slug'])).toBe('general-env')
    delete process.env[OPENAI]

    // fallback:false consults only the exact key.
    expect(await apiKeys.resolveApiKey(['openai', 'missing'], { fallback: false })).toBeNull()
    expect(await apiKeys.resolveApiKey(['openai', 'slug'], { fallback: false })).toBe('slug-stored')
  })

  it.runIf(ENFORCE_MODE)('writes the secrets file 0600 on POSIX', async () => {
    await apiKeys.writeApiKey(['openai'], 'sk-stored-123')
    const mode = statSync(apiKeysPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('moves a corrupt key file aside and resolves to no key instead of throwing', async () => {
    await writeFile(apiKeysPath, 'not json at all', 'utf8')
    await expect(apiKeys.resolveApiKey(['openai'])).resolves.toBeNull()

    const entries = await readdir(root)
    expect(entries.some((e) => e.startsWith('api-keys-') && e.endsWith('.invalid'))).toBe(true)
    expect(entries).not.toContain('api-keys.json')
  })

  it('treats a malformed obf: value as absent and warns naming the key id, rather than leniently decoding garbage', async () => {
    // Buffer.from(str, 'base64') is lenient and would happily "decode" this into
    // garbage bytes instead of throwing — the fix must reject it before decoding.
    await writeFile(apiKeysPath, JSON.stringify({ keys: { openai: 'obf:not-valid-base64!!' } }), 'utf8')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(apiKeys.resolveApiKey(['openai'])).resolves.toBeNull()
    await expect(apiKeys.hasApiKey(['openai'])).resolves.toBe(false)

    const warned = vi
      .mocked(console.warn)
      .mock.calls.map(([line]) => String(line))
      .find((line) => line.includes('stored api key is malformed'))
    expect(warned).toBeDefined()
    expect(JSON.parse(warned!)).toMatchObject({ level: 'warn', id: 'openai' })

    warnSpy.mockRestore()
  })

  it('rejects a wrong-length obf: payload (fails the length % 4 check) as absent', async () => {
    // 'QQ' (2 chars) is valid base64 alphabet but not a canonical length/padding.
    await writeFile(apiKeysPath, JSON.stringify({ keys: { openai: 'obf:QQ' } }), 'utf8')
    await expect(apiKeys.resolveApiKey(['openai'])).resolves.toBeNull()
  })

  it('round-trips a valid obf: value unchanged after the strict decode', async () => {
    await apiKeys.writeApiKey(['openai'], 'sk-round-trips-fine')
    const onDisk = JSON.parse(await readFile(apiKeysPath, 'utf8')) as { keys: Record<string, string> }
    expect(onDisk.keys['openai']).toMatch(/^obf:/)
    await expect(apiKeys.resolveApiKey(['openai'])).resolves.toBe('sk-round-trips-fine')
  })
})
