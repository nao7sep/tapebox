import { describe, expect, it } from 'vitest'
import {
  deriveStatus,
  recordLatest,
  rollupRole,
  type BinaryEntryFacts,
  type DependencyFacts,
  type Role,
} from '@shared/binary-status'

function facts(overrides: Partial<DependencyFacts> = {}): DependencyFacts {
  return {
    present: false,
    installedVersion: null,
    desiredVersion: null,
    lastCheckedAtUtc: null,
    ...overrides,
  }
}

function installed(overrides: Partial<DependencyFacts> = {}): DependencyFacts {
  return facts({ present: true, installedVersion: '2024.01.01', ...overrides })
}

// The derivation is pure and total (a function of the persisted facts alone).
describe('deriveStatus — pure and total', () => {
  it('is deterministic and never throws across the fact space', () => {
    const cases: DependencyFacts[] = [
      facts(),
      installed(),
      installed({ lastCheckedAtUtc: 't', desiredVersion: '2024.01.01' }),
      installed({ lastCheckedAtUtc: 't', desiredVersion: '2024.02.02' }),
      facts({ present: true }), // present but its version could not be read
    ]
    for (const f of cases) {
      expect(() => deriveStatus(f)).not.toThrow()
      expect(deriveStatus(f)).toEqual(deriveStatus(f))
    }
  })
})

// The four states + their roles (managed-runtime-dependencies-conventions Show table).
describe('the four-state model', () => {
  it('absent → not-installed (warning)', () => {
    expect(deriveStatus(facts())).toEqual({ state: 'not-installed', role: 'warning' })
  })

  it('absent optional dependency → not-installed (info)', () => {
    expect(deriveStatus(facts(), false)).toEqual({ state: 'not-installed', role: 'info' })
  })

  it('present, no successful check → installed-unchecked (info)', () => {
    expect(deriveStatus(installed())).toEqual({ state: 'installed-unchecked', role: 'info' })
  })

  it('present, version unreadable → installed-unchecked, even after a successful check', () => {
    // A probe that failed (or a sidecar that is absent) leaves nothing to compare
    // against the latest, so the row stays unchecked rather than reading current.
    const s = deriveStatus(facts({ present: true, desiredVersion: '2024.02.02', lastCheckedAtUtc: 't' }))
    expect(s).toEqual({ state: 'installed-unchecked', role: 'info' })
  })

  it('present, check confirms installed === latest → up-to-date (none)', () => {
    const s = deriveStatus(installed({ lastCheckedAtUtc: 't', desiredVersion: '2024.01.01' }))
    expect(s).toEqual({ state: 'up-to-date', role: 'none' })
  })

  it('present, check found a newer latest → update-available (warning)', () => {
    const s = deriveStatus(installed({ lastCheckedAtUtc: 't', desiredVersion: '2024.02.02' }))
    expect(s).toEqual({ state: 'update-available', role: 'warning' })
  })
})

// Honest-state: "not checking" can never read as "up to date" (a failed check writes
// nothing, so lastCheckedAtUtc stays null → installed-unchecked).
describe('honest state', () => {
  it('a matching version with NO successful check is not up-to-date', () => {
    const s = deriveStatus(installed({ installedVersion: '9', desiredVersion: '9', lastCheckedAtUtc: null }))
    expect(s.state).toBe('installed-unchecked')
  })

  it('presence is authoritative for not-installed regardless of stale version facts', () => {
    const s = deriveStatus(facts({ installedVersion: '1', desiredVersion: '2', lastCheckedAtUtc: 't' }))
    expect(s.state).toBe('not-installed')
  })
})

describe('recordLatest', () => {
  const entry: BinaryEntryFacts = { latestKnownVersion: '1', lastCheckedAtUtc: 'old' }

  it('records the resolved latest and the time it was resolved', () => {
    expect(recordLatest(entry, '2', 'now')).toEqual({
      latestKnownVersion: '2',
      lastCheckedAtUtc: 'now',
    })
  })

  // The one transition both writers share: an install learns the latest too, and
  // records nothing about what is now installed — that is read from the binary.
  it('is the whole of what a successful install persists', () => {
    expect(recordLatest({ latestKnownVersion: null, lastCheckedAtUtc: null }, '2', 'now')).toEqual({
      latestKnownVersion: '2',
      lastCheckedAtUtc: 'now',
    })
  })
})

describe('rollupRole', () => {
  it('takes the worst role present', () => {
    expect(rollupRole(['none', 'info', 'warning'])).toBe('warning')
    expect(rollupRole(['none', 'info'])).toBe('info')
    expect(rollupRole(['none', 'none'])).toBe('none')
    expect(rollupRole([])).toBe('none')
    expect(rollupRole(['none', 'info', 'warning', 'error'] as Role[])).toBe('error')
  })
})
