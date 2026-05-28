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
  name: string
  assets: GitHubAsset[]
}

export async function fetchLatestRelease(owner: string, repo: string): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tapebox',
    },
  })
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${owner}/${repo}`)
  }
  return res.json() as Promise<GitHubRelease>
}
