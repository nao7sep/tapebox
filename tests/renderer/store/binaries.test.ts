// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { BinaryStatus } from '@shared/ipc-contract'
import { absentBinaries, allBinariesUsable, binariesNeedAttention, derivedOf, summarizeBinaries } from '@renderer/store/binaries'

// A provisioned-and-current tool: the quiet baseline each case deviates from.
function status(over: Partial<BinaryStatus> = {}): BinaryStatus {
  return {
    name: 'yt-dlp',
    present: true,
    integrity: 'verified',
    installedVersion: '1.0.0',
    latestKnownVersion: '1.0.0',
    lastCheckedAtUtc: '2026-06-29T00:00:00.000Z',
    checkError: null,
    faultError: null,
    ...over,
  }
}

const absent = status({ present: false })
const faulted = status({ integrity: 'failed', faultError: 'corrupt' })
const stale = status({ latestKnownVersion: '2.0.0' })
const unchecked = status({ latestKnownVersion: null })
const checkFailed = status({ checkError: 'network down' })
const unmanaged = status({ integrity: null, installedVersion: null, latestKnownVersion: null })

describe('derivedOf', () => {
  it('maps a wire status to its derived state via the shared rule', () => {
    expect(derivedOf(status()).role).toBe('none')
    expect(derivedOf(faulted).lifecycle).toBe('faulted')
    expect(derivedOf(unmanaged).lifecycle).toBe('unmanaged')
  })
})

describe('summarizeBinaries — worst-role roll-up', () => {
  it('all current → quiet "Tools ready"', () => {
    expect(summarizeBinaries([status(), status()])).toEqual({ role: 'none', text: 'Tools ready', actionable: false })
  })

  it('absent → warning, pluralized, actionable', () => {
    expect(summarizeBinaries([absent, status()])).toMatchObject({ role: 'warning', text: '1 tool isn’t installed', actionable: true })
    expect(summarizeBinaries([absent, status({ name: 'ffmpeg', present: false })]).text).toBe('2 tools aren’t installed')
  })

  it('stale (no absent) → warning "updates available"', () => {
    expect(summarizeBinaries([stale, status()])).toMatchObject({ role: 'warning', text: '1 update available', actionable: true })
  })

  it('faulted or check-failed → error "needs attention"', () => {
    expect(summarizeBinaries([faulted, status()])).toMatchObject({ role: 'error', text: '1 tool needs attention', actionable: true })
    expect(summarizeBinaries([checkFailed])).toMatchObject({ role: 'error', actionable: true })
  })

  it('error outranks warning (a fault beside an absent tool still reads as error)', () => {
    const s = summarizeBinaries([faulted, absent])
    expect(s.role).toBe('error')
    expect(s.text).toBe('1 tool needs attention') // counts the error-role tools, not the absent one
  })

  it('unchecked → informational "Updates not checked" (benign, not actionable)', () => {
    expect(summarizeBinaries([unchecked, status()])).toEqual({ role: 'info', text: 'Updates not checked', actionable: false })
  })

  it('unmanaged → informational "Using your own copy"', () => {
    expect(summarizeBinaries([unmanaged, status()])).toEqual({ role: 'info', text: 'Using your own copy', actionable: false })
  })
})

describe('binariesNeedAttention — startup auto-open trigger', () => {
  it('true for Absent, Faulted, or Stale (full mumbler parity)', () => {
    expect(binariesNeedAttention([absent])).toBe(true)
    expect(binariesNeedAttention([faulted])).toBe(true)
    expect(binariesNeedAttention([stale])).toBe(true)
  })

  it('false for benign states (current / unchecked / unmanaged)', () => {
    expect(binariesNeedAttention([status(), unchecked, unmanaged])).toBe(false)
  })

  it('check-failed alone does not auto-open (matches mumbler’s needsAttention)', () => {
    expect(binariesNeedAttention([checkFailed])).toBe(false)
  })
})

describe('absentBinaries — the auto-download set (missing only)', () => {
  it('lists only the Absent tools, by name', () => {
    expect(absentBinaries([status(), absent, faulted])).toEqual(['yt-dlp'])
  })

  it('empty when nothing is absent', () => {
    expect(absentBinaries([status(), stale, unmanaged])).toEqual([])
  })
})

describe('allBinariesUsable', () => {
  it('true when every tool is provisioned or an unmanaged user copy', () => {
    expect(allBinariesUsable([status(), unmanaged])).toBe(true)
  })

  it('false when any tool is absent or faulted', () => {
    expect(allBinariesUsable([status(), absent])).toBe(false)
    expect(allBinariesUsable([status(), faulted])).toBe(false)
  })

  it('false for an empty set (status not yet known)', () => {
    expect(allBinariesUsable([])).toBe(false)
  })
})
