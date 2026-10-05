import { describe, expect, it } from 'vitest'
import {
  DependenciesSchema,
  defaultDependencies,
  freshBinaryEntry,
  launchCheckDue,
} from '@shared/dependencies'

const names = ['yt-dlp', 'ffmpeg', 'deno'] as const

describe('the dependencies (managed-facts) store', () => {
  it('defaults every managed binary to never-checked', () => {
    const d = defaultDependencies()
    expect(Object.keys(d).sort()).toEqual(['deno', 'ffmpeg', 'lastCheckAttemptAtUtc', 'yt-dlp'])
    expect(d.lastCheckAttemptAtUtc).toBeNull()
    for (const entry of names.map((name) => d[name])) {
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
    const d = defaultDependencies()
    for (const entry of names.map((name) => d[name])) {
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

describe('the launch check throttle', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z')
  const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString()

  it('runs when the last attempt is missing, invalid, in the future, or at least 24 hours old', () => {
    expect(launchCheckDue(null, now)).toBe(true)
    expect(launchCheckDue('yesterday', now)).toBe(true)
    expect(launchCheckDue('2026-10-02', now)).toBe(true)
    expect(launchCheckDue('2026-13-40T99:00:00.000Z', now)).toBe(true)
    expect(launchCheckDue(hoursAgo(-1), now)).toBe(true)
    expect(launchCheckDue(hoursAgo(24), now)).toBe(true)
    expect(launchCheckDue(hoursAgo(72), now)).toBe(true)
  })

  it('waits while the last attempt is under 24 hours old', () => {
    expect(launchCheckDue(hoursAgo(0), now)).toBe(false)
    expect(launchCheckDue(hoursAgo(23.99), now)).toBe(false)
  })

  it('reads a file without the attempt time as unreadable', () => {
    const { lastCheckAttemptAtUtc: _, ...withoutAttempt } = defaultDependencies()
    expect(DependenciesSchema.safeParse(withoutAttempt).success).toBe(false)
  })
})
