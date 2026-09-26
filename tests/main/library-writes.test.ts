import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/store/config', () => ({ getLibraryDir: () => '/library' }))

const { isLibraryMoving, tryClaimLibraryWrite, withLibraryMove, withLibraryWrite } = await import('@main/library-writes')

describe('library write gate', () => {
  it('refuses a move while an import, rename or export holds a write', async () => {
    let finishImport!: () => void
    const importing = withLibraryWrite((dir) => new Promise<string>((resolve) => { finishImport = () => resolve(dir) }))
    const move = vi.fn(async () => {})

    await expect(withLibraryMove(move)).rejects.toThrow("Can't move the library while downloads, imports, renames or exports are running.")
    expect(move).not.toHaveBeenCalled()

    finishImport()
    await expect(importing).resolves.toBe('/library')
    await withLibraryMove(move)
    expect(move).toHaveBeenCalledOnce()
  })

  it('refuses new writes while a move runs, and allows them once it settles', async () => {
    let finishMove!: () => void
    const moving = withLibraryMove(() => new Promise<void>((resolve) => { finishMove = resolve }))

    expect(isLibraryMoving()).toBe(true)
    expect(tryClaimLibraryWrite()).toBeNull()
    const work = vi.fn(async () => {})
    await expect(withLibraryWrite(work)).rejects.toThrow('The library is being moved to a new folder.')
    expect(work).not.toHaveBeenCalled()

    finishMove()
    await moving
    expect(isLibraryMoving()).toBe(false)
    await withLibraryWrite(work)
    expect(work).toHaveBeenCalledWith('/library')
  })

  it('releases a claim once however often release is called', async () => {
    const release = tryClaimLibraryWrite()!
    release()
    release()
    await expect(withLibraryMove(async () => 'moved')).resolves.toBe('moved')
  })
})
