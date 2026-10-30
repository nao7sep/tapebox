import { describe, expect, it, vi } from 'vitest'
import { until } from '../helpers/until'

vi.mock('@main/store/config', () => ({ getCollectionDir: () => '/library' }))

const { isCollectionMoving, withCollectionMove, withCollectionTurn } = await import('@main/collection-writes')

describe('library turns', () => {
  it('runs library actions one at a time in arrival order', async () => {
    let finishExport!: () => void
    const exporting = withCollectionTurn((dir) => new Promise<string>((resolve) => { finishExport = () => resolve(dir) }))
    const rename = vi.fn(async () => 'renamed')
    const renaming = withCollectionTurn(rename)

    await Promise.resolve()
    expect(rename).not.toHaveBeenCalled()
    finishExport()
    await expect(exporting).resolves.toBe('/library')
    await expect(renaming).resolves.toBe('renamed')
    expect(rename).toHaveBeenCalledWith('/library')
  })

  it('starts the next turn after a failed one', async () => {
    const failing = withCollectionTurn(async () => { throw new Error('copy failed') })
    const next = withCollectionTurn(async () => 'next')
    await expect(failing).rejects.toThrow('copy failed')
    await expect(next).resolves.toBe('next')
  })

  it('marks the library as moving only during the move turn', async () => {
    let finishMove!: () => void
    const moving = withCollectionMove(() => new Promise<void>((resolve) => { finishMove = resolve }))
    await until(() => expect(isCollectionMoving()).toBe(true))
    finishMove()
    await moving
    expect(isCollectionMoving()).toBe(false)
  })
})
