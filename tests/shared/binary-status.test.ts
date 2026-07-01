import { describe, expect, it } from 'vitest'
import {
  applyCheckSuccess,
  deriveStatus,
  nextEntryAfterInstall,
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
      facts({ present: true }), // present but no recorded version (user-placed)
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

  it('present, no successful check → installed-unchecked (info)', () => {
    expect(deriveStatus(installed())).toEqual({ state: 'installed-unchecked', role: 'info' })
  })

  it('present, a user-placed copy with no recorded version → installed-unchecked, even after a check', () => {
    // installedVersion null can't be compared to the latest, so it stays unchecked.
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

describe('applyCheckSuccess', () => {
  const entry: BinaryEntryFacts = { installedVersion: '1', latestKnownVersion: '1', lastCheckedAtUtc: 'old' }

  it('records the resolved latest and the check time, leaving installed untouched', () => {
    const next = applyCheckSuccess(entry, '2', 'now')
    expect(next).toEqual({ installedVersion: '1', latestKnownVersion: '2', lastCheckedAtUtc: 'now' })
  })
})

describe('nextEntryAfterInstall', () => {
  it('sets installed = latest = the acquired version as of now', () => {
    const next = nextEntryAfterInstall(
      { installedVersion: null, latestKnownVersion: '2', lastCheckedAtUtc: null },
      { version: '2', nowIso: 'now' },
    )
    expect(next).toEqual({ installedVersion: '2', latestKnownVersion: '2', lastCheckedAtUtc: 'now' })
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
