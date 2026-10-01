import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fixtures only — no network access and no bytes downloaded. These mirror the
// shape of a real `GET /repos/BtbN/FFmpeg-Builds/releases` response: the mutable
// `latest` release first, then immutable `autobuild-<timestamp>` releases newest
// first, per the managed-runtime-dependencies convention's requirement that
// Windows ffmpeg resolve to BtbN's immutable per-build release, never `latest`.
const fetchReleases = vi.fn()
vi.mock('@main/binaries/github', () => ({
  fetchLatestRelease: vi.fn(),
  fetchReleases: (...args: unknown[]) => fetchReleases(...args),
}))

const { resolveFfmpegWindows } = await import('@main/binaries/registry')

const asset = (name: string) => ({
  name,
  browser_download_url: `https://example.test/${name}`,
  size: 1,
})

const LATEST_POINTER_RELEASE = {
  tag_name: 'latest',
  name: 'Latest Auto-Build (2026-09-26 13:03)',
  assets: [
    asset('checksums.sha256'),
    asset('ffmpeg-master-latest-win64-gpl-shared.zip'),
    asset('ffmpeg-master-latest-win64-gpl.zip'),
  ],
}

const NEWEST_AUTOBUILD_RELEASE = {
  tag_name: 'autobuild-2026-09-26-13-03',
  name: 'Auto-Build 2026-09-26 13:03',
  assets: [
    asset('checksums.sha256'),
    asset('ffmpeg-N-126889-gb139ba11d8-win64-gpl-shared.zip'),
    asset('ffmpeg-N-126889-gb139ba11d8-win64-gpl.zip'),
  ],
}

const OLDER_AUTOBUILD_RELEASE = {
  tag_name: 'autobuild-2026-09-25-15-37',
  name: 'Auto-Build 2026-09-25 15:37',
  assets: [
    asset('checksums.sha256'),
    asset('ffmpeg-N-126856-ged27b2c498-win64-gpl-shared.zip'),
    asset('ffmpeg-N-126856-ged27b2c498-win64-gpl.zip'),
  ],
}

// resolveFfmpegWindows is exercised directly (not through binarySpecs.ffmpeg,
// which branches on process.platform) so this URL/tag resolution logic is
// covered on every CI platform, not only real Windows runners.
describe('Windows ffmpeg resolves to the immutable autobuild release', () => {
  beforeEach(() => fetchReleases.mockReset())

  it('skips the mutable `latest` pointer and pins the newest `autobuild-*` release', async () => {
    fetchReleases.mockResolvedValue([
      LATEST_POINTER_RELEASE,
      NEWEST_AUTOBUILD_RELEASE,
      OLDER_AUTOBUILD_RELEASE,
    ])
    const resolved = await resolveFfmpegWindows()
    expect(resolved.downloadUrl).toBe(
      'https://example.test/ffmpeg-N-126889-gb139ba11d8-win64-gpl.zip',
    )
    expect(resolved.integrity).toEqual({
      kind: 'sums',
      url: 'https://example.test/checksums.sha256',
      assetName: 'ffmpeg-N-126889-gb139ba11d8-win64-gpl.zip',
    })
    expect(resolved.version).toBe('autobuild-2026-09-26-13-03')
  })

  it('pins only a release whose tag is a full build timestamp', async () => {
    fetchReleases.mockResolvedValue([
      { ...NEWEST_AUTOBUILD_RELEASE, tag_name: 'autobuild-next' },
      OLDER_AUTOBUILD_RELEASE,
    ])
    expect((await resolveFfmpegWindows()).version).toBe('autobuild-2026-09-25-15-37')
  })

  it('never matches the `-shared` variant published alongside the GPL build', async () => {
    fetchReleases.mockResolvedValue([NEWEST_AUTOBUILD_RELEASE])
    const resolved = await resolveFfmpegWindows()
    expect(resolved.downloadUrl).not.toContain('shared')
  })

  it('falls back to the tag when the release name is null', async () => {
    fetchReleases.mockResolvedValue([{ ...NEWEST_AUTOBUILD_RELEASE, name: null }])
    const resolved = await resolveFfmpegWindows()
    expect(resolved.version).toBe('autobuild-2026-09-26-13-03')
  })

  it('throws when the release list has no autobuild release at all', async () => {
    fetchReleases.mockResolvedValue([LATEST_POINTER_RELEASE])
    await expect(resolveFfmpegWindows()).rejects.toThrow('no BtbN autobuild release found')
  })

  it('throws when the newest autobuild release has no matching win64 GPL asset', async () => {
    fetchReleases.mockResolvedValue([
      { tag_name: 'autobuild-2026-09-26-13-03', name: 'Auto-Build', assets: [asset('checksums.sha256')] },
    ])
    await expect(resolveFfmpegWindows()).rejects.toThrow('ffmpeg Windows asset not found')
  })
})
