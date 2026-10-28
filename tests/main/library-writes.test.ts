import { describe, expect, it, vi } from 'vitest'
import { until } from '../helpers/until'

vi.mock('@main/store/config', () => ({ getLibraryDir: () => '/library' }))

const { isLibraryMoving, withLibraryMove, withLibraryTurn } = await import('@main/library-writes')

describe('library turns', () => {
  it('runs library actions one at a time in arrival order', async () => {
    let finishExport!: () => void
    const exporting = withLibraryTurn((dir) => new Promise<string>((resolve) => { finishExport = () => resolve(dir) }))
    const rename = vi.fn(async () => 'renamed')
    const renaming = withLibraryTurn(rename)

    await Promise.resolve()
    expect(rename).not.toHaveBeenCalled()
    finishExport()
    await expect(exporting).resolves.toBe('/library')
    await expect(renaming).resolves.toBe('renamed')
    expect(rename).toHaveBeenCalledWith('/library')
  })

  it('starts the next turn after a failed one', async () => {
    const failing = withLibraryTurn(async () => { throw new Error('copy failed') })
    const next = withLibraryTurn(async () => 'next')
    await expect(failing).rejects.toThrow('copy failed')
    await expect(next).resolves.toBe('next')
  })

  it('marks the library as moving only during the move turn', async () => {
    let finishMove!: () => void
    const moving = withLibraryMove(() => new Promise<void>((resolve) => { finishMove = resolve }))
    await until(() => expect(isLibraryMoving()).toBe(true))
    finishMove()
    await moving
    expect(isLibraryMoving()).toBe(false)
  })
})
