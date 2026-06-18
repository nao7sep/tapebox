import { mkdtempSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

// api-keys.ts resolves its file path from TAPEBOX_HOME at import time (paths.ts),
// so the override must be set BEFORE the module is imported. Point the storage
// root at a throwaway temp dir — the override is the one path-relocation seam, the
// same way tests and production relocate the root (storage-path-conventions).
const root = mkdtempSync(join(tmpdir(), 'tapebox-apikeys-'))
const prevHome = process.env.TAPEBOX_HOME
process.env.TAPEBOX_HOME = root

const apiKeys = await import('@main/services/api-keys')
const apiKeysPath = join(root, 'api-keys.json')

const ENFORCE_MODE = process.platform !== 'win32'
const prevEnvKey = process.env.OPENAI_API_KEY

beforeEach(() => {
  delete process.env.OPENAI_API_KEY
})

afterEach(async () => {
  // Reset the stored key between tests so each starts from a known state.
  await apiKeys.clearAiKey().catch(() => {})
})

afterAll(() => {
  if (prevHome === undefined) delete process.env.TAPEBOX_HOME
  else process.env.TAPEBOX_HOME = prevHome
  if (prevEnvKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = prevEnvKey
})

describe('api-keys storage', () => {
  it('round-trips a stored key', async () => {
    await apiKeys.writeAiKey('sk-stored-123')
    expect(await apiKeys.hasAiKey()).toBe(true)
    expect(await apiKeys.readAiKey()).toBe('sk-stored-123')
  })

  it('does not store the key in plain text', async () => {
    await apiKeys.writeAiKey('sk-plaintext-secret')
    const onDisk = await readFile(apiKeysPath, 'utf8')
    expect(onDisk).not.toContain('sk-plaintext-secret')
  })

  it('clears the stored key', async () => {
    await apiKeys.writeAiKey('sk-stored-123')
    await apiKeys.clearAiKey()
    expect(await apiKeys.hasAiKey()).toBe(false)
    expect(await apiKeys.readAiKey()).toBeNull()
  })

  // storage-path-conventions: resolution prefers the environment.
  it('prefers OPENAI_API_KEY over the stored value', async () => {
    await apiKeys.writeAiKey('sk-stored-123')
    process.env.OPENAI_API_KEY = 'sk-from-env'
    expect(await apiKeys.readAiKey()).toBe('sk-from-env')
    expect(await apiKeys.hasAiKey()).toBe(true)
  })

  it('reports a key present from the environment even with nothing stored', async () => {
    process.env.OPENAI_API_KEY = 'sk-from-env-only'
    expect(await apiKeys.hasAiKey()).toBe(true)
    expect(await apiKeys.readAiKey()).toBe('sk-from-env-only')
  })

  it('ignores a blank/whitespace-only environment key and falls back to the stored value', async () => {
    await apiKeys.writeAiKey('sk-stored-123')
    process.env.OPENAI_API_KEY = '   '
    expect(await apiKeys.readAiKey()).toBe('sk-stored-123')
  })

  // storage-path-conventions: a secrets file is created 0600 on POSIX.
  it.runIf(ENFORCE_MODE)('writes the secrets file 0600 on POSIX', async () => {
    await apiKeys.writeAiKey('sk-stored-123')
    const mode = statSync(apiKeysPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
