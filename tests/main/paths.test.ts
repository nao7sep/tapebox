import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveStorageRoot } from '@main/paths'

// The TAPEBOX_HOME storage-root resolution (storage-path-conventions). The home
// directory is injected so these are pure, working-directory-independent
// assertions that never touch the real environment or filesystem. Mirrors
// mumbler's reference implementation.
describe('resolveStorageRoot', () => {
  const HOME = '/Users/test'

  it('defaults to <home>/.tapebox when the override is unset', () => {
    expect(resolveStorageRoot(undefined, HOME)).toBe(join(HOME, '.tapebox'))
  })

  it('defaults to <home>/.tapebox when the override is empty or whitespace-only', () => {
    expect(resolveStorageRoot('', HOME)).toBe(join(HOME, '.tapebox'))
    expect(resolveStorageRoot('   ', HOME)).toBe(join(HOME, '.tapebox'))
  })

  it('relocates the root to a set absolute override', () => {
    expect(resolveStorageRoot('/data/tapebox-profile', HOME)).toBe('/data/tapebox-profile')
  })

  it('trims surrounding whitespace before using the override', () => {
    expect(resolveStorageRoot('  /data/tapebox  ', HOME)).toBe('/data/tapebox')
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
    process.env.TAPEBOX_TEST_ROOT = '/mnt/disk2'
    try {
      expect(resolveStorageRoot('$TAPEBOX_TEST_ROOT/tapebox', HOME)).toBe('/mnt/disk2/tapebox')
      expect(resolveStorageRoot('${TAPEBOX_TEST_ROOT}/tapebox', HOME)).toBe('/mnt/disk2/tapebox')
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
