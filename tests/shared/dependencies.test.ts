import { describe, expect, it } from 'vitest'
import {
  DependenciesSchema,
  defaultDependencies,
  freshBinaryEntry,
} from '@shared/dependencies'

describe('the dependencies (managed-facts) store', () => {
  it('defaults every managed binary to never-checked', () => {
    const d = defaultDependencies()
    expect(Object.keys(d).sort()).toEqual(['deno', 'ffmpeg', 'yt-dlp'])
    for (const entry of Object.values(d)) {
      expect(entry).toEqual({
        latestKnownVersion: null,
        lastCheckedAtUtc: null,
      })
    }
    expect(freshBinaryEntry()).toEqual(d['yt-dlp'])
  })

  // The store holds NETWORK facts only. The installed version is read from the
  // binary itself, so persisting it here is what let the two drift apart.
  it('does not persist an installed version', () => {
    for (const entry of Object.values(defaultDependencies())) {
      expect(entry).not.toHaveProperty('installedVersion')
    }
  })

  it('accepts the fresh default it seeds', () => {
    expect(() => DependenciesSchema.parse(defaultDependencies())).not.toThrow()
  })

  // A per-binary entry drops any field the schema no longer lists, on the next
  // write (no migration code): the old installedVersion, and the older integrity
  // set before it.
  it('strips fields from earlier models, installedVersion included', () => {
    const raw = {
      ...defaultDependencies(),
      'yt-dlp': {
        installedVersion: '1',
        latestKnownVersion: '1',
        lastCheckedAtUtc: null,
        integrity: 'verified',
        verifiedSha256: 'abc',
        checkError: null,
        faultError: null,
      },
    }
    const parsed = DependenciesSchema.parse(raw)
    expect(parsed['yt-dlp']).toEqual({
      latestKnownVersion: '1',
      lastCheckedAtUtc: null,
    })
  })

  // The schema is authoritative on shape: a missing binary is rejected rather than
  // silently defaulted, so the store's self-heal (fall back to fresh facts) is a
  // deliberate load-time decision, not the schema quietly filling a hole.
  it('rejects a facts object missing a binary rather than defaulting it', () => {
    const { deno, ...withoutDeno } = defaultDependencies()
    void deno
    expect(DependenciesSchema.safeParse(withoutDeno).success).toBe(false)
  })
})
