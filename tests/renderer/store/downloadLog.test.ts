import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_LOG_ENTRIES, useDownloadLogStore } from '@renderer/store/downloadLog'

beforeEach(() => {
  useDownloadLogStore.setState({ entries: {}, trimmed: {} })
})

describe('download log', () => {
  it('keeps the newest lines and marks the tape once older lines leave', () => {
    const { prepend } = useDownloadLogStore.getState()
    for (let index = 0; index < MAX_LOG_ENTRIES; index++) prepend('t1', { kind: 'line', text: `line ${index}` })
    expect(useDownloadLogStore.getState().trimmed).toEqual({})

    prepend('t1', { kind: 'line', text: 'newest' })
    const state = useDownloadLogStore.getState()
    expect(state.entries.t1).toHaveLength(MAX_LOG_ENTRIES)
    expect(state.entries.t1![0]).toEqual({ kind: 'line', text: 'newest' })
    expect(state.entries.t1!.at(-1)).toEqual({ kind: 'line', text: 'line 1' })
    expect(state.trimmed).toEqual({ t1: true })
  })

  it('clears the mark with the tape history at a new attempt', () => {
    const { prepend, reset } = useDownloadLogStore.getState()
    for (let index = 0; index <= MAX_LOG_ENTRIES; index++) prepend('t1', { kind: 'line', text: `line ${index}` })
    reset('t1')
    expect(useDownloadLogStore.getState()).toMatchObject({ entries: {}, trimmed: {} })
  })
})
