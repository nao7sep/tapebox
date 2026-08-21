import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson, fetchText } from '@main/io/fetch-json'

function redirectedResponse(url: string): Response {
  return {
    url,
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: async () => ({ ok: true }),
    text: async () => 'checksum',
  } as Response
}

function redirectResponse(url: string, location: string): Response {
  return {
    url,
    ok: false,
    status: 302,
    statusText: 'Found',
    headers: new Headers({ location }),
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

  it('refuses a metadata downgrade before requesting the plaintext hop', async () => {
    const fetch = vi.fn(async () =>
      redirectResponse('https://api.example.test/release', 'http://mirror.test/release'))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchJson('https://api.example.test/release')).rejects.toThrow(
      'refusing non-https metadata redirect URL',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses a checksum downgrade before requesting the plaintext hop', async () => {
    const fetch = vi.fn(async () =>
      redirectResponse('https://example.test/sums', 'http://mirror.test/sums'))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchText('https://example.test/sums')).rejects.toThrow(
      'refusing non-https checksum redirect URL',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('follows an all-HTTPS metadata redirect chain', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(redirectResponse('https://api.example.test/release', '/v2/release'))
      .mockResolvedValueOnce(redirectedResponse('https://api.example.test/v2/release'))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchJson<{ ok: boolean }>('https://api.example.test/release')).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/v2/release',
      expect.objectContaining({ redirect: 'manual' }),
    )
  })
})
