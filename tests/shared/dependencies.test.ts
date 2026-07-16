import { describe, expect, it } from 'vitest'
import {
  DependenciesSchema,
  defaultDependencies,
  freshBinaryEntry,
} from '@shared/dependencies'

describe('the dependencies (managed-facts) store', () => {
  it('defaults every managed binary to never-installed, never-checked', () => {
    const d = defaultDependencies()
    expect(Object.keys(d).sort()).toEqual(['deno', 'ffmpeg', 'yt-dlp'])
    for (const entry of Object.values(d)) {
      expect(entry).toEqual({
        installedVersion: null,
        latestKnownVersion: null,
        lastCheckedAtUtc: null,
      })
    }
    expect(freshBinaryEntry()).toEqual(d['yt-dlp'])
  })

  it('accepts the fresh default it seeds', () => {
    expect(() => DependenciesSchema.parse(defaultDependencies())).not.toThrow()
  })

  // The behavior that used to be asserted against Settings.binaries: a per-binary
  // entry drops any legacy fields from the old model on parse (no migration code).
  it('strips legacy per-binary integrity fields (no migration code)', () => {
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
      installedVersion: '1',
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
