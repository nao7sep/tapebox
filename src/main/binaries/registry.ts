import { fetchLatestRelease } from './github'
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
    return {
      version: release.tag_name,
      downloadUrl: asset.browser_download_url,
      archive: null,
    }
  },
}

// ── Deno ────────────────────────────────────────────────────────────────────
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
    return {
      version: release.tag_name,
      downloadUrl: asset.browser_download_url,
      archive: { kind: 'zip', innerName: process.platform === 'win32' ? 'deno.exe' : 'deno' },
    }
  },
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────
type EvermeetInfo = {
  version: string
  download: { zip: { url: string } }
}

async function resolveFfmpegMacOS(): Promise<ResolvedAsset> {
  const res = await fetch('https://evermeet.cx/ffmpeg/info/ffmpeg/release')
  if (!res.ok) throw new Error(`evermeet.cx ${res.status}`)
  const info = (await res.json()) as EvermeetInfo
  return {
    version: info.version,
    downloadUrl: info.download.zip.url,
    archive: { kind: 'zip', innerName: 'ffmpeg' },
  }
}

async function resolveFfmpegWindows(): Promise<ResolvedAsset> {
  const release = await fetchLatestRelease('BtbN', 'FFmpeg-Builds')
  const asset = release.assets.find((a) => a.name === 'ffmpeg-master-latest-win64-gpl.zip')
  if (!asset) throw new Error('ffmpeg Windows asset not found')
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
  deno: denoSpec,
}

export const binaryNames: readonly BinaryName[] = ['yt-dlp', 'ffmpeg', 'deno']
