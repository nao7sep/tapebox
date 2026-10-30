import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ids = vi.hoisted(() => [] as string[])
vi.mock('nanoid', () => ({ nanoid: () => ids.shift()! }))

const { reserveTapeId } = await import('@main/core/stem')

let library: string
beforeEach(async () => { library = await mkdtemp(join(tmpdir(), 'tapebox-stem-')) })
afterEach(async () => { await rm(library, { recursive: true, force: true }) })

describe('reserveTapeId', () => {
  it('passes over an id another row holds in any case, and one whose folder is already there', async () => {
    await mkdir(join(library, 'Leftover01'))
    ids.push('TAKEN00001', 'Leftover01', 'Fresh00001')
    expect(await reserveTapeId(library, ['taken00001'])).toBe('Fresh00001')
    expect(ids).toEqual([])
  })
})
