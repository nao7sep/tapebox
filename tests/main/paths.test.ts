import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { paths, resolveStorageRoot } from '@main/paths'

// The TAPEBOX_HOME storage-root resolution (storage-path-conventions). The home
// directory is injected so these are pure, working-directory-independent
// assertions that never touch the real environment or filesystem. Mirrors
// mumbler's reference implementation.
describe('resolveStorageRoot', () => {
  const HOME = resolve(tmpdir(), 'tapebox-test-home')

  it('defaults to <home>/.tapebox when the override is unset', () => {
    expect(resolveStorageRoot(undefined, HOME)).toBe(join(HOME, '.tapebox'))
  })

  it('defaults to <home>/.tapebox when the override is empty or whitespace-only', () => {
    expect(resolveStorageRoot('', HOME)).toBe(join(HOME, '.tapebox'))
    expect(resolveStorageRoot('   ', HOME)).toBe(join(HOME, '.tapebox'))
  })

  it('relocates the root to a set absolute override', () => {
    const profile = resolve(tmpdir(), 'tapebox-profile')
    expect(resolveStorageRoot(profile, HOME)).toBe(profile)
  })

  it('trims surrounding whitespace before using the override', () => {
    const profile = resolve(tmpdir(), 'tapebox')
    expect(resolveStorageRoot(`  ${profile}  `, HOME)).toBe(profile)
  })

  it('expands a leading ~ against the home directory', () => {
    expect(resolveStorageRoot('~', HOME)).toBe(HOME)
    expect(resolveStorageRoot('~/elsewhere/tapebox', HOME)).toBe(join(HOME, 'elsewhere', 'tapebox'))
  })

  it('absolutizes a relative override against HOME, never the working directory', () => {
    expect(resolveStorageRoot('profiles/work', HOME)).toBe(join(HOME, 'profiles', 'work'))
  })

  it('expands $VAR / ${VAR} environment references in the override', () => {
    const previous = process.env.TAPEBOX_TEST_ROOT
    process.env.TAPEBOX_TEST_ROOT = resolve(tmpdir(), 'tapebox-disk2')
    try {
      const expected = join(process.env.TAPEBOX_TEST_ROOT, 'tapebox')
      expect(resolveStorageRoot('$TAPEBOX_TEST_ROOT/tapebox', HOME)).toBe(expected)
      expect(resolveStorageRoot('${TAPEBOX_TEST_ROOT}/tapebox', HOME)).toBe(expected)
    } finally {
      if (previous === undefined) delete process.env.TAPEBOX_TEST_ROOT
      else process.env.TAPEBOX_TEST_ROOT = previous
    }
  })

  it('throws when a set override expands to empty, rather than collapsing onto home', () => {
    // A non-empty override that is ENTIRELY an unset $VAR reference expands to ''.
    // That is a misconfiguration the convention says to report as a startup error,
    // not to silently fall back to ~/.tapebox (which a bare-home collapse would do).
    const previous = process.env.TAPEBOX_UNSET_VAR
    delete process.env.TAPEBOX_UNSET_VAR
    try {
      // It must throw — not return the home directory or the default ~/.tapebox.
      expect(() => resolveStorageRoot('$TAPEBOX_UNSET_VAR', HOME)).toThrow(/empty path/)
    } finally {
      if (previous === undefined) delete process.env.TAPEBOX_UNSET_VAR
      else process.env.TAPEBOX_UNSET_VAR = previous
    }
  })
})

// The durable tape-library catalog is catalog.json, not session.json — the name
// must not imply throwaway state. It is a distinct file from the user-editable
// config and the window layout; all three sit side by side under the storage root.
describe('paths catalog file', () => {
  it('resolves the catalog to catalog.json under the storage root', () => {
    expect(basename(paths.catalog)).toBe('catalog.json')
    expect(dirname(paths.catalog)).toBe(paths.root)
  })

  it('keeps the catalog separate from config and layout', () => {
    expect(basename(paths.config)).toBe('config.json')
    expect(basename(paths.layout)).toBe('layout.json')
    expect(paths.catalog).not.toBe(paths.config)
    expect(paths.catalog).not.toBe(paths.layout)
    expect(paths.catalog).not.toBe(paths.apiKeys)
  })
})
