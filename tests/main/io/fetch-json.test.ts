import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson, fetchText } from '@main/io/fetch-json'

function redirectedResponse(url: string): Response {
  return {
    url,
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ ok: true }),
    text: async () => 'checksum',
  } as Response
}

describe('effective response URL policy', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('refuses an HTTPS metadata request that finishes on HTTP without retrying it', async () => {
    const fetch = vi.fn(async () => redirectedResponse('http://mirror.test/release'))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchJson('https://api.example.test/release')).rejects.toThrow(
      'refusing non-https metadata response URL',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses an HTTPS checksum request that finishes on HTTP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => redirectedResponse('http://mirror.test/sums')))
    await expect(fetchText('https://example.test/sums')).rejects.toThrow(
      'refusing non-https checksum response URL',
    )
  })
})
