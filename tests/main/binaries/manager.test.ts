import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/settings'

// checkForUpdates is the orchestration seam for the convention's honest-state rule:
// a successful resolve records the latest + time; a failed one writes NOTHING. The
// config store and the upstream registry are mocked at their module boundaries so
// the fold is exercised without touching the network or disk.
const settingsRef: { current: Settings } = { current: null as unknown as Settings }

vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@main/store/config', () => ({
  getSettings: () => settingsRef.current,
  mutateSettings: vi.fn(async (mutator: (s: Settings) => Partial<Settings>) => {
    settingsRef.current = { ...settingsRef.current, ...mutator(settingsRef.current) }
    return settingsRef.current
  }),
}))

vi.mock('@main/binaries/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/binaries/registry')>()
  return {
    ...actual,
    binarySpecs: {
      'yt-dlp': { name: 'yt-dlp', resolveLatest: vi.fn() },
      ffmpeg: { name: 'ffmpeg', resolveLatest: vi.fn() },
      deno: { name: 'deno', resolveLatest: vi.fn() },
    },
  }
})

import { checkForUpdates, downloadTempPath } from '@main/binaries/manager'
import { binarySpecs } from '@main/binaries/registry'
import { freshBinaryEntry } from '@shared/settings'

function seed(): void {
  settingsRef.current = {
    binaries: {
      'yt-dlp': freshBinaryEntry(),
      ffmpeg: freshBinaryEntry(),
      deno: freshBinaryEntry(),
    },
  } as Settings
}

const resolved = (version: string) =>
  ({ version, downloadUrl: 'https://x', archive: null, integrity: { kind: 'none' } }) as never

describe('checkForUpdates — a failed check writes nothing (I3)', () => {
  it('folds only successful resolves; a failed binary keeps its facts null', async () => {
    seed()
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockResolvedValue(resolved('2024.01.01'))
    vi.mocked(binarySpecs.ffmpeg.resolveLatest).mockRejectedValue(new Error('offline'))
    vi.mocked(binarySpecs.deno.resolveLatest).mockResolvedValue(resolved('1.44'))

    await checkForUpdates()

    const b = settingsRef.current.binaries
    // Successful checks record the latest version and a timestamp.
    expect(b['yt-dlp'].latestKnownVersion).toBe('2024.01.01')
    expect(b['yt-dlp'].lastCheckedAtUtc).not.toBeNull()
    expect(b.deno.latestKnownVersion).toBe('1.44')
    expect(b.deno.lastCheckedAtUtc).not.toBeNull()
    // The failed check wrote nothing — no version, no timestamp.
    expect(b.ffmpeg.latestKnownVersion).toBeNull()
    expect(b.ffmpeg.lastCheckedAtUtc).toBeNull()
  })
})

describe('downloadTempPath', () => {
  it('is <name>-<nanoid>.partial under temp/, per the derived-sibling-name grammar', () => {
    const p = downloadTempPath('yt-dlp')
    expect(p).toMatch(/[/\\]temp[/\\]yt-dlp-[A-Za-z0-9_-]{10}\.partial$/)
  })

  it('discriminates by a random nanoid, not a raw Date.now() epoch', () => {
    // The bug this replaced: Date.now() as the discriminator, which two installs
    // started in the same millisecond would collide on. A nanoid discriminator
    // means back-to-back calls virtually never coincide.
    const first = downloadTempPath('yt-dlp')
    const second = downloadTempPath('yt-dlp')
    expect(first).not.toBe(second)
  })
})
