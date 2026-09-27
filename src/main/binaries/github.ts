import { fetchJson } from '@main/io/fetch-json'

/**
 * Minimal GitHub Releases API helper.
 * Unauthenticated; rate limit is 60 requests/hour per IP, which is plenty
 * for our handful of binary lookups.
 */

export type GitHubAsset = {
  name: string
  browser_download_url: string
  size: number
}

export type GitHubRelease = {
  tag_name: string
  // The API permits a null release name; consumers must fall back to the tag.
  name: string | null
  assets: GitHubAsset[]
}

export async function fetchLatestRelease(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
  return fetchJson<GitHubRelease>(url, {
    signal,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tapebox',
    },
  })
}

/**
 * The most recent releases, newest first — used where the mutable `latest`
 * pointer is not itself an acceptable pin (managed-runtime-dependencies-
 * conventions) and the caller instead picks an immutable release out of the
 * list, such as BtbN's rolling `autobuild-<timestamp>` tags.
 */
export async function fetchReleases(
  owner: string,
  repo: string,
  signal?: AbortSignal,
  perPage = 10,
): Promise<GitHubRelease[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${perPage}`
  return fetchJson<GitHubRelease[]>(url, {
    signal,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tapebox',
    },
  })
}
