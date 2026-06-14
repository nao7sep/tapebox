import { fetchLatestRelease } from './github'
import { fetchJson } from '@main/io/fetch-json'
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
  versionFlag: '--version',
  parseVersion: (stdout) => {
    const m = stdout.match(/deno ([\d.]+)/)
    return m?.[1] ?? stdout.trim().split('\n')[0] ?? 'unknown'
  },
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
type EvermeetInfo = {
  version: string
  download: { zip: { url: string } }
}

async function resolveFfmpegMacOS(): Promise<ResolvedAsset> {
  const info = await fetchJson<EvermeetInfo>('https://evermeet.cx/ffmpeg/info/ffmpeg/release')
  const downloadUrl = info.download.zip.url
  return {
    version: info.version,
    downloadUrl,
    archive: { kind: 'zip', innerName: 'ffmpeg' },
    // evermeet publishes no checksum but signs every build with its PGP key; the
    // detached signature sits beside the zip as `<zip>.sig` and is verified against
    // the pinned evermeet key (see integrity.ts / evermeet-key.ts).
    integrity: { kind: 'openpgp', signatureUrl: `${downloadUrl}.sig` },
  }
}

async function resolveFfmpegWindows(): Promise<ResolvedAsset> {
  const release = await fetchLatestRelease('BtbN', 'FFmpeg-Builds')
  const asset = release.assets.find((a) => a.name === 'ffmpeg-master-latest-win64-gpl.zip')
  if (!asset) throw new Error('ffmpeg Windows asset not found')
  // BtbN's nightly builds publish neither a checksum nor a signature, so this installs
  // unverified (logged); https-only transport is still enforced.
  return {
    version: release.tag_name,
    downloadUrl: asset.browser_download_url,
    archive: { kind: 'zip', innerName: 'ffmpeg.exe' },
    integrity: { kind: 'none' },
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
  deno: denoSpec,
}

export const binaryNames: readonly BinaryName[] = ['yt-dlp', 'ffmpeg', 'deno']
