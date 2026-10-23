import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson, fetchText, fetchRedirectLocation } from '@main/io/fetch-json'

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

function response(status: number, body = '{"ok":true}'): Response {
  const result = new Response(body, { status })
  Object.defineProperty(result, 'url', { value: 'https://example.test/resource', configurable: true })
  return result
}

describe('managed lookup retry and response lifetime', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([400, 401, 403, 404])('does not retry HTTP %s and discards its body even if cancellation fails', async (status) => {
    const result = response(status)
    const cancel = vi.spyOn(result.body!, 'cancel').mockRejectedValue(new Error('cleanup failed'))
    const fetch = vi.fn().mockResolvedValue(result)
    vi.stubGlobal('fetch', fetch)
    await expect(fetchJson('https://example.test/resource')).rejects.toThrow(`HTTP ${status}`)
    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([408, 429, 500, 503])('retries HTTP %s after disposing the failed response', async (status) => {
    vi.useFakeTimers()
    const result = response(status)
    const cancel = vi.spyOn(result.body!, 'cancel')
    const fetch = vi.fn().mockResolvedValueOnce(result).mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetch)
    const outcome = fetchJson('https://example.test/resource')
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(outcome).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry malformed JSON or an unknown fetch failure', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(200, '{bad'))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchJson('https://example.test/resource')).rejects.toBeInstanceOf(SyntaxError)
    expect(fetch).toHaveBeenCalledOnce()
    const failure = new Error('unknown failure')
    fetch.mockRejectedValue(failure)
    await expect(fetchJson('https://example.test/resource')).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cancels the retry wait without issuing another lookup', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetch = vi.fn().mockImplementation(async () => response(503))
    vi.stubGlobal('fetch', fetch)
    const outcome = fetchJson('https://example.test/resource', { signal: controller.signal }).catch((err) => err)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await outcome).toBe(controller.signal.reason)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retries a typed transient fetch failure and preserves its cause on exhaustion', async () => {
    vi.useFakeTimers()
    const failure = new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) })
    const fetch = vi.fn().mockRejectedValue(failure)
    vi.stubGlobal('fetch', fetch)
    const outcome = fetchText('https://example.test/resource').catch((err) => err)
    await vi.advanceTimersByTimeAsync(22_000)
    expect(await outcome).toMatchObject({ cause: failure })
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})


it('discards a header-only redirect body on success and on policy failure', async () => {
  const success = response(302)
  success.headers.set('location', '/versioned')
  const successCancel = vi.spyOn(success.body!, 'cancel')
  const unsafe = response(302)
  Object.defineProperty(unsafe, 'url', { value: 'http://example.test/resource', configurable: true })
  const unsafeCancel = vi.spyOn(unsafe.body!, 'cancel')
  const fetch = vi.fn().mockResolvedValueOnce(success).mockResolvedValueOnce(unsafe)
  vi.stubGlobal('fetch', fetch)
  try {
    await expect(fetchRedirectLocation('https://example.test/resource')).resolves.toBe('/versioned')
    await expect(fetchRedirectLocation('https://example.test/resource')).rejects.toThrow('non-https')
    expect(successCancel).toHaveBeenCalledOnce()
    expect(unsafeCancel).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})
