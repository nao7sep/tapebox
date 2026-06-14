import { fetchLatestRelease } from './github'
import { fetchJson } from '@main/io/fetch-json'
import type { BinaryName } from '@shared/ipc-contract'

/**
 * Per-binary specification: how to resolve the latest version, where to find
 * the binary inside the downloaded archive (if any), and how to query the
 * installed version.
 *
 * Linux ffmpeg currently throws — BtbN's Linux builds ship as .tar.xz and we
 * don't bundle xz extraction yet. macOS and Windows are supported.
 */

export type ResolvedAsset = {
  version: string
  downloadUrl: string
  archive: { kind: 'zip'; innerName: string } | null
  // Vendor-published integrity, verified before the binary is made executable (see
  // checksum.ts). Either a directly-known hash, or a sums file to fetch and parse at
  // install time. Both absent ⇒ the vendor publishes none for this asset; it installs
  // unverified (logged), with https-only transport still enforced.
  sha256?: string | null
  checksums?: { url: string; assetName: string } | null
}

export type BinarySpec = {
  name: BinaryName
  versionFlag: string
  parseVersion: (stdout: string) => string
  resolveLatest: () => Promise<ResolvedAsset>
}

// ── yt-dlp ──────────────────────────────────────────────────────────────────
function ytDlpAssetName(): string {
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'linux') return 'yt-dlp_linux'
  throw new Error(`Unsupported platform for yt-dlp: ${process.platform}`)
}

const ytDlpSpec: BinarySpec = {
  name: 'yt-dlp',
  versionFlag: '--version',
  parseVersion: (stdout) => stdout.trim().split('\n')[0] ?? 'unknown',
  resolveLatest: async () => {
    const release = await fetchLatestRelease('yt-dlp', 'yt-dlp')
    const assetName = ytDlpAssetName()
    const asset = release.assets.find((a) => a.name === assetName)
    if (!asset) throw new Error(`yt-dlp asset not found: ${assetName}`)
    // yt-dlp publishes a SHA2-256SUMS file alongside its binaries — found here in the
    // already-fetched release (no extra request) and parsed at install time.
    const sums = release.assets.find((a) => a.name === 'SHA2-256SUMS')
    return {
      version: release.tag_name,
      downloadUrl: asset.browser_download_url,
      archive: null,
      checksums: sums ? { url: sums.browser_download_url, assetName } : null,
    }
  },
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────
type EvermeetInfo = {
  version: string
  download: { zip: { url: string; sha256?: string } }
}

async function resolveFfmpegMacOS(): Promise<ResolvedAsset> {
  const info = await fetchJson<EvermeetInfo>('https://evermeet.cx/ffmpeg/info/ffmpeg/release')
  return {
    version: info.version,
    downloadUrl: info.download.zip.url,
    archive: { kind: 'zip', innerName: 'ffmpeg' },
    sha256: info.download.zip.sha256 ?? null,
  }
}

async function resolveFfmpegWindows(): Promise<ResolvedAsset> {
  const release = await fetchLatestRelease('BtbN', 'FFmpeg-Builds')
  const asset = release.assets.find((a) => a.name === 'ffmpeg-master-latest-win64-gpl.zip')
  if (!asset) throw new Error('ffmpeg Windows asset not found')
  // BtbN's nightly builds publish no per-asset checksum, so this installs unverified
  // (logged); https-only transport is still enforced.
  return {
    version: release.tag_name,
    downloadUrl: asset.browser_download_url,
    archive: { kind: 'zip', innerName: 'ffmpeg.exe' },
  }
}

const ffmpegSpec: BinarySpec = {
  name: 'ffmpeg',
  versionFlag: '-version',
  parseVersion: (stdout) => {
    const m = stdout.match(/ffmpeg version ([^\s]+)/)
    return m?.[1] ?? 'unknown'
  },
  resolveLatest: async () => {
    if (process.platform === 'darwin') return resolveFfmpegMacOS()
    if (process.platform === 'win32')  return resolveFfmpegWindows()
    throw new Error(
      `ffmpeg auto-install not yet supported on ${process.platform}. ` +
      `Install ffmpeg manually and place it at ~/.tapebox/bin/ffmpeg.`,
    )
  },
}

export const binarySpecs: Record<BinaryName, BinarySpec> = {
  'yt-dlp': ytDlpSpec,
  ffmpeg: ffmpegSpec,
}

export const binaryNames: readonly BinaryName[] = ['yt-dlp', 'ffmpeg']
