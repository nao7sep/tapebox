import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ids = vi.hoisted(() => [] as string[])
vi.mock('nanoid', () => ({ nanoid: () => ids.shift()! }))

const { reserveTapeId } = await import('@main/core/stem')

let collection: string
beforeEach(async () => { collection = await mkdtemp(join(tmpdir(), 'tapebox-stem-')) })
afterEach(async () => { await rm(collection, { recursive: true, force: true }) })

describe('reserveTapeId', () => {
  it('passes over an id another tape holds in any case, and one whose folder is already in the Inbox or on the Shelf', async () => {
    await mkdir(join(collection, 'inbox', 'Leftover01'), { recursive: true })
    await mkdir(join(collection, 'shelf', 'Leftover02'), { recursive: true })
    ids.push('TAKEN00001', 'Leftover01', 'Leftover02', 'Fresh00001')
    expect(await reserveTapeId(collection, ['taken00001'])).toBe('Fresh00001')
    expect(ids).toEqual([])
  })
})
