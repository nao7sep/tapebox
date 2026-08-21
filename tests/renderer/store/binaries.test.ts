// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { BinaryStatus } from '@shared/ipc-contract'
import {
  allBinariesUsable,
  applyBinaryCheckResult,
  binariesNeedAttention,
  derivedOf,
  summarizeBinaries,
  useBinariesStore,
} from '@renderer/store/binaries'

// An up-to-date tool: the quiet baseline each case deviates from.
function status(over: Partial<BinaryStatus> = {}): BinaryStatus {
  return {
    name: 'yt-dlp',
    present: true,
    installedVersion: '1.0.0',
    latestKnownVersion: '1.0.0',
    lastCheckedAtUtc: '2026-06-29T00:00:00.000Z',
    ...over,
  }
}

const absent = status({ present: false })
const updateAvailable = status({ latestKnownVersion: '2.0.0' })
const unchecked = status({ latestKnownVersion: null, lastCheckedAtUtc: null })
// Present, and a check DID succeed — but the binary would not report its own
// version, so there is nothing to compare it against.
const unreadable = status({ installedVersion: null, latestKnownVersion: '2.0.0' })

describe('derivedOf', () => {
  it('maps a wire status to its derived four-state via the shared rule', () => {
    expect(derivedOf(status())).toEqual({ state: 'up-to-date', role: 'none' })
    expect(derivedOf(absent).state).toBe('not-installed')
    expect(derivedOf(updateAvailable).state).toBe('update-available')
    expect(derivedOf(unchecked).state).toBe('installed-unchecked')
    expect(derivedOf(unreadable).state).toBe('installed-unchecked')
  })
})

describe('summarizeBinaries — worst-role roll-up', () => {
  it('all up to date → quiet "Tools ready"', () => {
    expect(summarizeBinaries([status(), status()])).toEqual({ role: 'none', text: 'Tools ready', actionable: false })
  })

  it('not-installed → warning, pluralized, actionable', () => {
    expect(summarizeBinaries([absent, status()])).toMatchObject({ role: 'warning', text: '1 tool isn’t installed', actionable: true })
    expect(summarizeBinaries([absent, status({ name: 'ffmpeg', present: false })]).text).toBe('2 tools aren’t installed')
  })

  it('update-available (no absent) → warning "updates available"', () => {
    expect(summarizeBinaries([updateAvailable, status()])).toMatchObject({ role: 'warning', text: '1 update available', actionable: true })
  })

  it('not-installed outranks update-available (reports the missing count)', () => {
    const s = summarizeBinaries([absent, updateAvailable])
    expect(s.role).toBe('warning')
    expect(s.text).toBe('1 tool isn’t installed')
  })

  it('installed-unchecked → informational "Updates not checked" (benign, not actionable)', () => {
    expect(summarizeBinaries([unchecked, status()])).toEqual({ role: 'info', text: 'Updates not checked', actionable: false })
  })

  // Both are informational, but only one asks something of the user: a tool whose
  // own version could not be read needs re-acquiring, and the set-wide Check can
  // never clear it, so the roll-up says so and opens the modal.
  it('a tool whose version could not be read says so, and is actionable', () => {
    expect(summarizeBinaries([unreadable, status()])).toEqual({
      role: 'info',
      text: '1 tool couldn’t be read',
      actionable: true,
    })
    expect(summarizeBinaries([unreadable, status({ name: 'deno', installedVersion: null })]).text).toBe(
      '2 tools couldn’t be read',
    )
  })

  it('an unreadable tool never outranks a real warning', () => {
    expect(summarizeBinaries([unreadable, absent]).text).toBe('1 tool isn’t installed')
  })
})

describe('binariesNeedAttention — startup auto-open trigger', () => {
  it('true only for a not-installed tool (the one blocking condition)', () => {
    expect(binariesNeedAttention([absent])).toBe(true)
  })

  it('false for benign states (up-to-date / update-available / unchecked / unreadable)', () => {
    expect(binariesNeedAttention([status(), updateAvailable, unchecked, unreadable])).toBe(false)
  })
})

describe('allBinariesUsable', () => {
  it('true when every tool is present, whatever its version reads as', () => {
    expect(allBinariesUsable([status(), unreadable])).toBe(true)
  })

  it('false when any tool is not installed', () => {
    expect(allBinariesUsable([status(), absent])).toBe(false)
  })

  it('false for an empty set (status not yet known)', () => {
    expect(allBinariesUsable([])).toBe(false)
  })
})

describe('applyBinaryCheckResult', () => {
  it('retains partial launch/manual failures beside the returned statuses', () => {
    const statuses = [status()]
    const failures = [{ name: 'ffmpeg' as const, message: 'offline' }]

    applyBinaryCheckResult({ statuses, failures })

    expect(useBinariesStore.getState()).toMatchObject({ statuses, checkFailures: failures })
  })
})
