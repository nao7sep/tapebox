import { fetchLatestRelease, fetchReleases } from './github'
import { fetchRedirectLocation } from '@main/io/fetch-json'
import { assertHttpsUrl } from '@main/io/network'
import type { BinaryName } from '@shared/ipc-contract'
import { FFMPEG_BUILD_TAG } from '@shared/binary-status'
import type { AssetIntegrity } from './integrity'

/**
 * Per-binary specification: how to resolve the latest version, where to find
 * the binary inside the downloaded archive (if any), and how the INSTALLED
 * version is read back from the artifact.
 *
 * Linux ffmpeg currently throws — BtbN's Linux builds ship as .tar.xz and we
 * don't bundle xz extraction yet. macOS and Windows are supported.
 */

/**
 * How a binary's installed version is read — always from the artifact, never from
 * the facts store (managed-runtime-dependencies-conventions).
 *
 *   probe    run the installed binary and parse what it prints. Preferred,
 *            because the artifact answers for itself: a copy the app has no
 *            record of installing — one predating the tracking, hand-placed, or
 *            left by an install whose record was lost — still reports its true
 *            version. `parse` returns null on output it does not recognize, so
 *            noise never becomes a version.
 *   sidecar  read `bin/<name>.json`, written beside the binary after a
 *            successful install. Used where the tool's self-reported version
 *            cannot be compared with what the source calls "latest": BtbN's
 *            Windows ffmpeg is a rolling master build reporting `N-119123-g…`,
 *            published under a release tagged with its build time — two
 *            different namespaces, so probing it would report a phantom update
 *            forever. `parse` returns null for a stored value of any other
 *            shape, which reads as version unreadable and offers Update.
 */
export type InstalledVersionSource =
  | { kind: 'probe'; args: readonly string[]; parse: (stdout: string) => string | null }
  | { kind: 'sidecar'; parse: (stored: string) => string | null }

/**
 * Strip vendor noise so installed and latest are compared on the same form
 * (the convention's "normalize before comparing"): martin-riedl appends
 * `-https://www.martin-riedl.de` to ffmpeg's version, and GitHub tags carry a
 * leading `v` (deno tags `v2.9.7`, whose binary reports `2.9.7`). Applied to
 * BOTH sides — every resolved latest below, and every probe read — since the
 * two come from different sources and only agree once normalized.
 */
export function normalizeVersion(raw: string): string {
  return raw
    .trim()
    .replace(/-https?:\/\/\S+$/i, '')
    .replace(/^v/i, '')
    .trim()
}

/** The first non-empty line of a probe's output — every tool below prints its
 *  version banner there and detail after it. */
function firstLine(stdout: string): string {
  return stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

export type ResolvedAsset = {
  version: string
  downloadUrl: string
  archive: { kind: 'zip'; innerName: string } | null
  maxDownloadBytes: number
  maxInstalledBytes: number
  // How this asset's bytes are verified before being made executable.
  integrity: AssetIntegrity
}

export type BinarySpec = {
  name: BinaryName
  resolveLatest: (signal?: AbortSignal) => Promise<ResolvedAsset>
  /** Where this binary's installed version is read from — see InstalledVersionSource. */
  installedVersion: InstalledVersionSource
}

// ── yt-dlp ──────────────────────────────────────────────────────────────────
function ytDlpAssetName(): string {
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'linux') return 'yt-dlp_linux'
  throw new Error(`Unsupported platform for yt-dlp: ${process.platform}`)
}

/** yt-dlp prints its version and nothing else: `2026.07.04` (a nightly adds a
 *  fourth `.hhmmss` component). Anything not date-shaped is not a version. */
export function parseYtDlpVersion(stdout: string): string | null {
  const line = firstLine(stdout)
  return /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(line) ? normalizeVersion(line) : null
}

const ytDlpSpec: BinarySpec = {
  name: 'yt-dlp',
  installedVersion: { kind: 'probe', args: ['--version'], parse: parseYtDlpVersion },
  resolveLatest: async (signal) => {
    const release = await fetchLatestRelease('yt-dlp', 'yt-dlp', signal)
    const assetName = ytDlpAssetName()
    const asset = release.assets.find((a) => a.name === assetName)
    if (!asset) throw new Error(`yt-dlp asset not found: ${assetName}`)
    // yt-dlp publishes a SHA2-256SUMS file alongside its binaries — found here in the
    // already-fetched release (no extra request) and parsed at install time.
    const sums = release.assets.find((a) => a.name === 'SHA2-256SUMS')
    if (!sums) throw new Error('yt-dlp release has no SHA2-256SUMS')
    return {
      version: normalizeVersion(release.tag_name),
      downloadUrl: asset.browser_download_url,
      archive: null,
      maxDownloadBytes: 64 * 1024 * 1024,
      maxInstalledBytes: 64 * 1024 * 1024,
      integrity: { kind: 'sums', url: sums.browser_download_url, assetName },
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

/** deno's banner is three lines; the first is `deno 2.9.1 (stable, release,
 *  aarch64-apple-darwin)`. Its release tags carry a `v` the binary does not, which
 *  normalizeVersion strips from both sides. */
export function parseDenoVersion(stdout: string): string | null {
  const match = /^deno (\S+)/.exec(firstLine(stdout))
  return match ? normalizeVersion(match[1]) : null
}

const denoSpec: BinarySpec = {
  name: 'deno',
  installedVersion: { kind: 'probe', args: ['--version'], parse: parseDenoVersion },
  resolveLatest: async (signal) => {
    const release = await fetchLatestRelease('denoland', 'deno', signal)
    const assetName = denoAssetName()
    const asset = release.assets.find((a) => a.name === assetName)
    if (!asset) throw new Error(`deno asset not found: ${assetName}`)
    // Each zip ships a sibling `<asset>.sha256sum`, found in the already-fetched
    // release. Unix assets use a sums line; Windows assets use Get-FileHash output.
    const sums = release.assets.find((a) => a.name === `${assetName}.sha256sum`)
    if (!sums) throw new Error(`Deno release has no ${assetName}.sha256sum`)
    return {
      version: normalizeVersion(release.tag_name),
      downloadUrl: asset.browser_download_url,
      archive: { kind: 'zip', innerName: process.platform === 'win32' ? 'deno.exe' : 'deno' },
      maxDownloadBytes: 128 * 1024 * 1024,
      maxInstalledBytes: 256 * 1024 * 1024,
      integrity: { kind: 'sums', url: sums.browser_download_url, assetName },
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
  return normalizeVersion(m[1])
}

/** ffmpeg's banner opens `ffmpeg version 8.1.2-https://www.martin-riedl.de
 *  Copyright (c) …`; normalizeVersion drops the builder suffix, leaving the
 *  upstream release the martin-riedl build id also names. */
export function parseFfmpegVersion(stdout: string): string | null {
  const match = /^ffmpeg version (\S+)/.exec(firstLine(stdout))
  return match ? normalizeVersion(match[1]) : null
}

async function resolveFfmpegMacOS(signal?: AbortSignal): Promise<ResolvedAsset> {
  // macOS is arm64-only by design: the fleet ships Apple Silicon builds and a primary
  // goal is surviving Rosetta removal, so tapebox never fetches an x86_64 ffmpeg on
  // macOS. (Windows x64 is native on Windows and is unaffected by this.)
  const location = await fetchRedirectLocation(
    `${MARTIN_BASE}/redirect/latest/macos/arm64/release/ffmpeg.zip`,
    { signal },
  )
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
    maxDownloadBytes: 512 * 1024 * 1024,
    maxInstalledBytes: 512 * 1024 * 1024,
    // The sibling `<file>.sha256` holds a single `<hash>  ffmpeg.zip` line, verified
    // against the downloaded bytes at install (see integrity.ts).
    integrity: { kind: 'sums', url: `${downloadUrl}.sha256`, assetName: 'ffmpeg.zip' },
  }
}

// BtbN's win64 GPL asset inside an `autobuild-*` release is named after the
// build it carries (`ffmpeg-N-<rev>-g<hash>-win64-gpl.zip`), not the fixed
// `ffmpeg-master-latest-win64-gpl.zip` name the rolling `latest` release
// aliases it to. Anchored so the `-shared` variant published alongside it in
// the same release never matches.
const FFMPEG_WIN64_GPL_ASSET = /^ffmpeg-N-\d+-g[0-9a-f]+-win64-gpl\.zip$/

/**
 * Resolve BtbN's newest immutable build, never the mutable `latest` tag.
 * `latest` is a GitHub Release whose tag GitHub keeps repointing at each new
 * build — re-downloading it later can silently fetch different bytes under the
 * same tag, which the managed-runtime-dependencies convention forbids for an
 * executable. Every build `latest` ever points at is also published in its own
 * right under an `autobuild-<timestamp>` tag that GitHub never moves once cut;
 * the releases list (newest first) is walked for that tag, so the pin is the
 * newest genuinely immutable release rather than the pointer to it.
 */
export async function resolveFfmpegWindows(signal?: AbortSignal): Promise<ResolvedAsset> {
  const releases = await fetchReleases('BtbN', 'FFmpeg-Builds', signal)
  const release = releases.find((r) => FFMPEG_BUILD_TAG.test(r.tag_name))
  if (!release) throw new Error('no BtbN autobuild release found')
  const asset = release.assets.find((a) => FFMPEG_WIN64_GPL_ASSET.test(a.name))
  if (!asset) throw new Error(`ffmpeg Windows asset not found in ${release.tag_name}`)
  // BtbN publishes a combined `checksums.sha256` (`<hash>  <file>` per line) inside
  // the same release; the GPL build's own line is verified at install.
  const sums = release.assets.find((a) => a.name === 'checksums.sha256')
  if (!sums) throw new Error(`ffmpeg Windows release ${release.tag_name} has no checksums.sha256`)
  // The immutable release tag (`autobuild-2026-08-19-19-21`) is the build's
  // identity: stored in the sidecar at install and compared as a string.
  return {
    version: release.tag_name,
    downloadUrl: asset.browser_download_url,
    archive: { kind: 'zip', innerName: 'ffmpeg.exe' },
    maxDownloadBytes: 1024 * 1024 * 1024,
    maxInstalledBytes: 512 * 1024 * 1024,
    integrity: { kind: 'sums', url: sums.browser_download_url, assetName: asset.name },
  }
}

/** A stored Windows ffmpeg identity is a BtbN build tag; anything else is unreadable. */
export function parseFfmpegBuildTag(stored: string): string | null {
  return FFMPEG_BUILD_TAG.test(stored) ? stored : null
}

const ffmpegSpec: BinarySpec = {
  name: 'ffmpeg',
  // Windows records the build tag in a sidecar: BtbN ships rolling master builds
  // (`N-119123-g…`) under a release tagged with its build time, so the binary's
  // own banner and the source's "latest" never meet. Everywhere else the
  // binary is probed — martin-riedl's macOS build reports the same numbered
  // release its build id names, and a user-placed Linux ffmpeg (no managed
  // source there) at least reports what it is instead of reading unreadable.
  installedVersion:
    process.platform === 'win32'
      ? { kind: 'sidecar', parse: parseFfmpegBuildTag }
      : { kind: 'probe', args: ['-version'], parse: parseFfmpegVersion },
  resolveLatest: async (signal) => {
    if (process.platform === 'darwin') return resolveFfmpegMacOS(signal)
    if (process.platform === 'win32')  return resolveFfmpegWindows(signal)
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
