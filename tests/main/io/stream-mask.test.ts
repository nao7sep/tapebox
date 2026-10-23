import { describe, expect, it } from 'vitest'
import { createOutputMasker } from '@main/io/stream-mask'
import { maskCredentials, maskYtdlpOutput } from '@main/io/mask'

function masked(text: string, pieces: number, credentials: string[] = []): string {
  const chunks: string[] = []
  const masker = createOutputMasker(credentials, (chunk) => chunks.push(chunk))
  for (let index = 0; index < text.length; index += pieces) masker.feed(text.slice(index, index + pieces))
  masker.finish()
  return chunks.join('')
}

describe('incremental subprocess masking', () => {
  const text = JSON.stringify({ title: 'ordinary 🌏 metadata', nested: { cookies: 'large-secret', Authorization: 'Bearer token-value', 'Proxy-Authorization': 'Basic login' }, url: 'https://user:pass@example.test/v?sig=secret&quality=high&pot=proof#anchor', echo: 'known-secret', description: 'quotes: "cookies": "ordinary text"' })
  it('preserves existing masking across every character boundary', () => {
    const expected = maskYtdlpOutput(maskCredentials(text, ['known-secret']))
    for (let size = 1; size <= text.length; size++) expect(masked(text, size, ['known-secret']), `chunk size ${size}`).toBe(expected)
  })
  it('masks incomplete credential values and trailing escapes', () => {
    for (const text of ['{"cookie":"hidden', '{"cookie":"hidden\\', '{"authorization":"Bearer hidden']) {
      expect(masked(text, 1)).toBe(maskYtdlpOutput(text))
    }
  })
  it('streams large ordinary strings and discards secret value contents without buffering a line', () => {
    let received = 0
    let largest = 0
    const masker = createOutputMasker([], (chunk) => { received += chunk.length; largest = Math.max(largest, chunk.length) })
    masker.feed('{"description":"')
    for (let index = 0; index < 1000; index++) masker.feed('a'.repeat(4096))
    expect(received).toBeGreaterThan(4_000_000)
    masker.feed('","cookie":"')
    const before = received
    for (let index = 0; index < 1000; index++) masker.feed('b'.repeat(4096))
    expect(received - before).toBeLessThan(30)
    masker.feed('"}'); masker.finish()
    expect(largest).toBeLessThanOrEqual(8193)
  })
})
