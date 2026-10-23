import { expect, it } from 'vitest'
import { createScanStore } from '@main/store/scan-store'
import { SCAN_PAGE_SIZE, type ScanResult } from '@shared/ipc-contract'

const entry = (i: number, extra: Partial<ScanResult> = {}): ScanResult => ({ sourceId: String(i), sourceUrl: `https://example.test/${i}`, title: `Title ${i}`, durationSeconds: null, uploadDateUtc: null, thumbnailUrl: null, alreadyInLibrary: false, unavailable: null, ...extra })
it('pages all results, deduplicates, and owns filtered selection without a result cap', async () => {
  const store = await createScanStore()
  try {
    for (let i = 0; i < 1200; i++) await store.append(entry(i))
    await store.append(entry(0))
    await store.append(entry(1200, { alreadyInLibrary: true }))
    await store.append(entry(1201, { unavailable: { reason: 'gone' } }))
    const first = await store.page('', 0)
    expect(first).toMatchObject({ total: 1202, selected: 1200, inLibrary: 1, unavailable: 1, matched: 1202, start: 0 })
    expect(first.entries).toHaveLength(SCAN_PAGE_SIZE)
    const tail = await store.page('', 1199)
    expect(tail.entries.map(e => e.sourceId)).toEqual(['1199', '1200', '1201'])
    await store.select({ selected: false, search: 'TITLE 1' })
    expect((await store.page('title 1', 0)).entries.every(e => !e.selected)).toBe(true)
    await store.append(entry(1202)) // Future entries retain the established default.
    expect((await store.page('title 1202', 0)).entries[0]?.selected).toBe(true)
    await store.select({ selected: true, search: '' })
    await store.select({ selected: false, sourceUrl: 'https://example.test/0' })
    let after = 0
    const urls: string[] = []
    while (true) {
      const selected = await store.selected(after)
      expect(selected.count).toBe(1200)
      expect(selected.entries.length).toBeLessThanOrEqual(SCAN_PAGE_SIZE)
      if (!selected.entries.length) break
      urls.push(...selected.entries.map(e => e.url))
      after = selected.entries.at(-1)!.sequence
    }
    expect(urls).toHaveLength(1200)
    expect(new Set(urls).size).toBe(1200)
    expect(urls.at(-1)).toBe('https://example.test/1202')
    expect((await store.page('', 99999)).start).toBe(1202)
    expect(await store.page('no match', 99999)).toMatchObject({ start: 0, matched: 0, entries: [] })
  } finally { await store.close() }
  await expect(store.page('', 0)).rejects.toThrow('exited')
})
