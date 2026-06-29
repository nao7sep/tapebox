import { describe, expect, it } from 'vitest'
import {
  applyCheckOutcome,
  deriveStatus,
  nextEntryAfterInstall,
  nextEntryAfterVerify,
  rollupRole,
  type BinaryEntryFacts,
  type DependencyFacts,
  type Role,
} from '@shared/binary-status'

// A Provisioned-and-Current dependency: the quiet baseline every case below
// deviates from one fact at a time.
function facts(over: Partial<DependencyFacts> = {}): DependencyFacts {
  return {
    present: true,
    integrity: 'verified',
    installedVersion: '1.0.0',
    desiredVersion: '1.0.0',
    lastCheckedAtUtc: '2026-06-29T00:00:00.000Z',
    checkError: null,
    faultError: null,
    ...over,
  }
}

describe('deriveStatus — lifecycle', () => {
  it('absent when not present', () => {
    const s = deriveStatus(facts({ present: false }))
    expect(s.lifecycle).toBe('absent')
    expect(s.role).toBe('warning')
    expect(s.operation).toBe('provision')
  })

  it('faulted when integrity failed (error role, detail from faultError)', () => {
    const s = deriveStatus(facts({ integrity: 'failed', faultError: 'hash mismatch' }))
    expect(s.lifecycle).toBe('faulted')
    expect(s.role).toBe('error')
    expect(s.detail).toBe('hash mismatch')
    expect(s.operation).toBe('repair')
  })

  it('unmanaged when present but never provisioned by us', () => {
    const s = deriveStatus(facts({ integrity: null, installedVersion: null, desiredVersion: null }))
    expect(s.lifecycle).toBe('unmanaged')
    expect(s.role).toBe('info')
    expect(s.operation).toBe('provision')
    expect(s.currency).toBeNull()
  })

  it('provisioned (legacy) when present with a recorded version but no integrity field yet', () => {
    // A config written before the integrity field existed: installedVersion proves
    // we provisioned it, so it must not be mistaken for an unmanaged user copy.
    const s = deriveStatus(facts({ integrity: null }))
    expect(s.lifecycle).toBe('provisioned')
    expect(s.currency).toBe('current')
  })
})

describe('deriveStatus — currency (provisioned only)', () => {
  it('current when desired matches installed → no indicator', () => {
    const s = deriveStatus(facts())
    expect(s.currency).toBe('current')
    expect(s.role).toBe('none')
    expect(s.operation).toBeNull()
  })

  it('unchecked when no desired version resolved yet', () => {
    const s = deriveStatus(facts({ desiredVersion: null }))
    expect(s.currency).toBe('unchecked')
    expect(s.role).toBe('info')
    expect(s.operation).toBe('check')
  })

  it('stale when desired differs from installed', () => {
    const s = deriveStatus(facts({ desiredVersion: '2.0.0' }))
    expect(s.currency).toBe('stale')
    expect(s.role).toBe('warning')
    expect(s.operation).toBe('update')
  })

  it('check-failed when a check recorded an error (detail from checkError)', () => {
    const s = deriveStatus(facts({ checkError: 'network down' }))
    expect(s.currency).toBe('check-failed')
    expect(s.role).toBe('error')
    expect(s.detail).toBe('network down')
    expect(s.operation).toBe('check')
  })
})

describe('deriveStatus — transient overlay (I6)', () => {
  it('running shows progress without changing persisted lifecycle', () => {
    const s = deriveStatus(facts({ present: false }), {
      kind: 'running', operation: 'provision', percent: 42, phase: 'download',
    })
    expect(s.lifecycle).toBe('absent')
    expect(s.running).toEqual({ operation: 'provision', percent: 42, phase: 'download' })
  })

  it('failed overlays an error but leaves lifecycle intact (absent after a failed provision)', () => {
    const s = deriveStatus(facts({ present: false }), {
      kind: 'failed', operation: 'provision', error: 'download failed',
    })
    expect(s.lifecycle).toBe('absent') // not some "install-failed" state
    expect(s.role).toBe('error')
    expect(s.detail).toBe('download failed')
  })
})

describe('honest-state invariants', () => {
  it('I2 — currency is null unless provisioned', () => {
    const notProvisioned: DependencyFacts[] = [
      facts({ present: false }),
      facts({ integrity: 'failed' }),
      facts({ integrity: null, installedVersion: null, desiredVersion: null }), // unmanaged
    ]
    for (const f of notProvisioned) expect(deriveStatus(f).currency).toBeNull()
  })

  it('I3 — a failed check never reads as current, regardless of version match', () => {
    // Even though desired === installed, a recorded check error is the fresher truth.
    expect(deriveStatus(facts({ checkError: 'timeout' })).currency).toBe('check-failed')
  })

  it('I4 — fault is only ever the recorded integrity result, never inferred', () => {
    expect(deriveStatus(facts({ integrity: 'verified' })).lifecycle).toBe('provisioned')
    expect(deriveStatus(facts({ integrity: 'failed' })).lifecycle).toBe('faulted')
  })

  it('I5 — provisioned + current is the only quiet (role none) state', () => {
    expect(deriveStatus(facts()).role).toBe('none')
    const noisy: DependencyFacts[] = [
      facts({ present: false }),
      facts({ integrity: 'failed' }),
      facts({ integrity: null, installedVersion: null, desiredVersion: null }),
      facts({ desiredVersion: null }),
      facts({ desiredVersion: '2.0.0' }),
      facts({ checkError: 'x' }),
    ]
    for (const f of noisy) expect(deriveStatus(f).role).not.toBe('none')
  })
})

function entry(over: Partial<BinaryEntryFacts> = {}): BinaryEntryFacts {
  return {
    installedVersion: '1.0.0',
    latestKnownVersion: '1.0.0',
    lastCheckedAtUtc: '2026-06-01T00:00:00.000Z',
    integrity: 'verified',
    verifiedSha256: 'abc',
    checkError: 'stale error',
    faultError: null,
    ...over,
  }
}

describe('applyCheckOutcome', () => {
  const now = '2026-06-29T12:00:00.000Z'

  it('success records the desired version, advances the timestamp, clears the error', () => {
    const next = applyCheckOutcome(entry({ checkError: 'old' }), { ok: true, version: '2.0.0' }, now)
    expect(next).toMatchObject({ latestKnownVersion: '2.0.0', lastCheckedAtUtc: now, checkError: null })
  })

  it('failure records the error and timestamp but NEVER rewrites the version (I3)', () => {
    const before = entry({ latestKnownVersion: '1.0.0', checkError: null })
    const next = applyCheckOutcome(before, { ok: false, error: 'network down' }, now)
    expect(next.checkError).toBe('network down')
    expect(next.lastCheckedAtUtc).toBe(now)
    expect(next.latestKnownVersion).toBe('1.0.0') // untouched
  })
})

describe('nextEntryAfterInstall', () => {
  const o = { version: '3.0.0', integrityVerified: true, determinable: true, sha256: 'deadbeef', nowIso: 'NOW' }

  it('verified + determinable → provisioned, records hash, clears errors, current', () => {
    const next = nextEntryAfterInstall(entry({ checkError: 'x', faultError: 'y' }), o)
    expect(next).toMatchObject({
      installedVersion: '3.0.0', latestKnownVersion: '3.0.0', integrity: 'verified',
      verifiedSha256: 'deadbeef', checkError: null, faultError: null,
    })
  })

  it('undeterminable version → faulted (I4), no hash recorded', () => {
    const next = nextEntryAfterInstall(entry(), { ...o, determinable: false })
    expect(next.integrity).toBe('failed')
    expect(next.verifiedSha256).toBeNull()
    expect(next.faultError).toMatch(/did not report a usable version/)
  })

  it('unverified integrity (source published no sums) → integrity left unestablished', () => {
    const next = nextEntryAfterInstall(entry(), { ...o, integrityVerified: false })
    expect(next.integrity).toBeNull()
    expect(next.verifiedSha256).toBeNull()
  })
})

describe('nextEntryAfterVerify', () => {
  it('matching hash + determinable → re-affirms verified, clears fault', () => {
    const next = nextEntryAfterVerify(entry({ verifiedSha256: 'h1', faultError: 'old' }), { currentSha: 'h1', determinable: true })
    expect(next).toMatchObject({ integrity: 'verified', faultError: null })
  })

  it('changed file → faulted', () => {
    const next = nextEntryAfterVerify(entry({ verifiedSha256: 'h1' }), { currentSha: 'h2', determinable: true })
    expect(next.integrity).toBe('failed')
    expect(next.faultError).toMatch(/changed since it was verified/)
  })

  it('undeterminable version → faulted', () => {
    const next = nextEntryAfterVerify(entry(), { currentSha: 'h1', determinable: false })
    expect(next.integrity).toBe('failed')
  })

  it('no baseline hash → trust-on-first-verify records the current hash', () => {
    const next = nextEntryAfterVerify(entry({ verifiedSha256: null }), { currentSha: 'fresh', determinable: true })
    expect(next).toMatchObject({ integrity: 'verified', verifiedSha256: 'fresh' })
  })
})

describe('rollupRole — I7 worst role wins', () => {
  it('takes the maximum by precedence error > warning > info > none', () => {
    expect(rollupRole(['none', 'info', 'warning'])).toBe('warning')
    expect(rollupRole(['warning', 'error', 'info'])).toBe('error')
    expect(rollupRole(['none', 'none'])).toBe('none')
    expect(rollupRole([])).toBe('none')
  })

  const cases: [Role[], Role][] = [
    [['info', 'none'], 'info'],
    [['warning', 'warning'], 'warning'],
    [['error'], 'error'],
  ]
  it.each(cases)('rollup(%j) = %s', (roles, expected) => {
    expect(rollupRole(roles)).toBe(expected)
  })
})
