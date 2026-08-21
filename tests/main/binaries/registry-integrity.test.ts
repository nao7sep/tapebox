import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchLatestRelease = vi.fn()
vi.mock('@main/binaries/github', () => ({
  fetchLatestRelease: (...args: unknown[]) => fetchLatestRelease(...args),
}))

const { binarySpecs } = await import('@main/binaries/registry')

function release(assets: Array<{ name: string; browser_download_url: string; size: number }>) {
  return { tag_name: 'v1.2.3', name: 'Build 1.2.3', assets }
}

const asset = (name: string) => ({
  name,
  browser_download_url: `https://example.test/${name}`,
  size: 1,
})

function ytDlpName(): string {
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (process.platform === 'linux') return 'yt-dlp_linux'
  return 'yt-dlp.exe'
}

function denoName(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64'
      ? 'deno-aarch64-unknown-linux-gnu.zip'
      : 'deno-x86_64-unknown-linux-gnu.zip'
  }
  return 'deno-x86_64-pc-windows-msvc.zip'
}

describe('registry integrity is mandatory', () => {
  beforeEach(() => fetchLatestRelease.mockReset())

  it('refuses a yt-dlp release without SHA2-256SUMS', async () => {
    fetchLatestRelease.mockResolvedValue(release([asset(ytDlpName())]))
    await expect(binarySpecs['yt-dlp'].resolveLatest()).rejects.toThrow('no SHA2-256SUMS')
  })

  it('refuses a Deno release without its per-asset checksum', async () => {
    const name = denoName()
    fetchLatestRelease.mockResolvedValue(release([asset(name)]))
    await expect(binarySpecs.deno.resolveLatest()).rejects.toThrow(`has no ${name}.sha256sum`)
  })

  it.runIf(process.platform === 'win32')('refuses a Windows ffmpeg release without checksums.sha256', async () => {
    fetchLatestRelease.mockResolvedValue(release([asset('ffmpeg-master-latest-win64-gpl.zip')]))
    await expect(binarySpecs.ffmpeg.resolveLatest()).rejects.toThrow('has no checksums.sha256')
  })
})
