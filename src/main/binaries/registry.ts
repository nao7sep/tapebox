import { fetchLatestRelease } from './github'
import { fetchRedirectLocation } from '@main/io/fetch-json'
import { assertHttpsUrl } from '@main/io/network'
import type { BinaryName } from '@shared/ipc-contract'
import type { AssetIntegrity } from './integrity'

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
  // How this asset's bytes are verified before being made executable — a sums file,
  // a detached OpenPGP signature, or nothing the vendor publishes (see integrity.ts).
  integrity: AssetIntegrity
}

export type BinarySpec = {
  name: BinaryName
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
      integrity: sums
        ? { kind: 'sums', url: sums.browser_download_url, assetName }
        : { kind: 'none' },
    }
  },
}

// ── Deno ──────────────────────────────────────────────────────────────────
// yt-dlp's external JavaScript runtime: yt-dlp discovers it on PATH (see
// ytdlp.ts, which adds ~/.tapebox/bin) and uses it to run player JS / solve
// challenges on sites that need it. denoland publishes a per-asset
// `<asset>.sha256sum` next to each zip, verified before install (see checksum.ts).
function denoAssetName(): string {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin' && a === 'arm64') return 'deno-aarch64-apple-darwin.zip'
  if (p === 'darwin' && a === 'x64')   return 'deno-x86_64-apple-darwin.zip'
  if (p === 'win32'  && a === 'x64')   return 'deno-x86_64-pc-windows-msvc.zip'
  if (p === 'linux'  && a === 'x64')   return 'deno-x86_64-unknown-linux-gnu.zip'
  if (p === 'linux'  && a === 'arm64') return 'deno-aarch64-unknown-linux-gnu.zip'
  throw new Error(`Unsupported platform/arch for deno: ${p}/${a}`)
}

const denoSpec: BinarySpec = {
  name: 'deno',
  resolveLatest: async () => {
    const release = await fetchLatestRelease('denoland', 'deno')
    const assetName = denoAssetName()
    const asset = release.assets.find((a) => a.name === assetName)
    if (!asset) throw new Error(`deno asset not found: ${assetName}`)
    // Each zip ships a sibling `<asset>.sha256sum` holding a single `<hash>  <asset>`
    // line — found in the already-fetched release (no extra request) and parsed at
    // install time, identical in shape to yt-dlp's SHA2-256SUMS entries.
    const sums = release.assets.find((a) => a.name === `${assetName}.sha256sum`)
    return {
      version: release.tag_name,
      downloadUrl: asset.browser_download_url,
      archive: { kind: 'zip', innerName: process.platform === 'win32' ? 'deno.exe' : 'deno' },
      integrity: sums
        ? { kind: 'sums', url: sums.browser_download_url, assetName }
        : { kind: 'none' },
    }
  },
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────
// macOS: martin-riedl.de publishes native arm64 (and amd64) static builds, each
// with a per-file SHA-256 sidecar. It exposes no JSON API; the stable "latest
// release" is a redirect whose Location carries the build id (`<epoch>_<version>`),
// from which the version and the sibling `.sha256` URL are derived. A third-party
// source accepted deliberately under the native-binary conventions' warn-and-
// escalate rule — the former source (evermeet) ships Intel-only and cannot satisfy
// the arm64 requirement.
const MARTIN_BASE = 'https://ffmpeg.martin-riedl.de'

/**
 * Extract the ffmpeg version from a martin-riedl download path. The build id is the
 * path segment before the file, shaped `<epoch>_<version>` (e.g. `1778761665_8.1.1`);
 * the version is the part after the underscore. Throws on an unrecognized path, so a
 * changed redirect surfaces as a failed check, never a silently wrong version.
 */
export function parseMartinBuildVersion(downloadPath: string): string {
  const m = downloadPath.match(/\/\d+_([^/]+)\/ffmpeg\.zip$/)
  if (!m) throw new Error(`unrecognized martin-riedl ffmpeg path: ${downloadPath}`)
  return m[1]
}

async function resolveFfmpegMacOS(): Promise<ResolvedAsset> {
  // macOS is arm64-only by design: the fleet ships Apple Silicon builds and a primary
  // goal is surviving Rosetta removal, so tapebox never fetches an x86_64 ffmpeg on
  // macOS. (Windows x64 is native on Windows and is unaffected by this.)
  const location = await fetchRedirectLocation(`${MARTIN_BASE}/redirect/latest/macos/arm64/release/ffmpeg.zip`)
  // The redirect Location could be an absolute URL; refuse a downgrade before it
  // becomes the download URL and (with `.sha256`) the integrity URL. The fetch
  // helpers assert https too, but rejecting here keeps a bad Location from ever
  // being treated as a resolved asset.
  const downloadUrl = new URL(location, MARTIN_BASE).toString()
  assertHttpsUrl(downloadUrl, 'ffmpeg download')
  return {
    version: parseMartinBuildVersion(new URL(downloadUrl).pathname),
    downloadUrl,
    archive: { kind: 'zip', innerName: 'ffmpeg' },
    // The sibling `<file>.sha256` holds a single `<hash>  ffmpeg.zip` line, verified
    // against the downloaded bytes at install (see integrity.ts).
    integrity: { kind: 'sums', url: `${downloadUrl}.sha256`, assetName: 'ffmpeg.zip' },
  }
}

async function resolveFfmpegWindows(): Promise<ResolvedAsset> {
  const release = await fetchLatestRelease('BtbN', 'FFmpeg-Builds')
  const assetName = 'ffmpeg-master-latest-win64-gpl.zip'
  const asset = release.assets.find((a) => a.name === assetName)
  if (!asset) throw new Error('ffmpeg Windows asset not found')
  // BtbN publishes a combined `checksums.sha256` (`<hash>  <file>` per line); the
  // GPL build's line is verified at install — closing the former integrity:none gap.
  const sums = release.assets.find((a) => a.name === 'checksums.sha256')
  return {
    version: release.tag_name,
    downloadUrl: asset.browser_download_url,
    archive: { kind: 'zip', innerName: 'ffmpeg.exe' },
    integrity: sums
      ? { kind: 'sums', url: sums.browser_download_url, assetName }
      : { kind: 'none' },
  }
}

const ffmpegSpec: BinarySpec = {
  name: 'ffmpeg',
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
  deno: denoSpec,
}

export const binaryNames: readonly BinaryName[] = ['yt-dlp', 'ffmpeg', 'deno']
