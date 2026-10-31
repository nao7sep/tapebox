import { beforeEach, describe, expect, it } from 'vitest'

import { useOrderFailuresStore } from '@renderer/store/orderFailures'
import type { Message } from '@shared/i18n/translate'

// Opaque stand-ins: the store keeps whatever message it is given.
const note = (name: string) => ({ key: name }) as unknown as Message

beforeEach(() => {
  useOrderFailuresStore.setState({ boxes: null, shelfTapes: {}, attempts: {}, pending: {} })
})

describe('order failure ownership', () => {
  it('retains independent box-list and per-box tape-list failures', () => {
    const state = useOrderFailuresStore.getState()
    state.setBoxes(note('Boxes failed'))
    state.setShelfTapes('box:a', note('Box A tapes failed'))
    state.setShelfTapes('box:b', note('Box B tapes failed'))

    expect(useOrderFailuresStore.getState()).toMatchObject({
      boxes: note('Boxes failed'),
      shelfTapes: {
        'box:a': note('Box A tapes failed'),
        'box:b': note('Box B tapes failed'),
      },
    })
  })

  it('clears only the matching list failure', () => {
    const state = useOrderFailuresStore.getState()
    state.setShelfTapes('box:a', note('Box A tapes failed'))
    state.setShelfTapes('box:b', note('Box B tapes failed'))
    state.setShelfTapes('box:a', null)

    expect(useOrderFailuresStore.getState().shelfTapes).toEqual({
      'box:b': note('Box B tapes failed'),
    })
  })

  it('supersedes only a later attempt for the same list without clearing retained results', () => {
    const state = useOrderFailuresStore.getState()
    state.setBoxes(note('Boxes failed'))
    const boxes = state.beginAttempt('boxes', [])
    const loose = state.beginAttempt('shelf:loose', [])
    const boxA = state.beginAttempt('shelf:box:a', [])
    const boxB = state.beginAttempt('shelf:box:b', [])
    const newerBoxA = state.beginAttempt('shelf:box:a', [])

    expect(state.isCurrentAttempt('boxes', boxes)).toBe(true)
    expect(state.isCurrentAttempt('shelf:loose', loose)).toBe(true)
    expect(state.isCurrentAttempt('shelf:box:a', boxA)).toBe(false)
    expect(state.isCurrentAttempt('shelf:box:a', newerBoxA)).toBe(true)
    expect(state.isCurrentAttempt('shelf:box:b', boxB)).toBe(true)
    expect(useOrderFailuresStore.getState().boxes).toEqual(note('Boxes failed'))
  })

  it('advances the confirmed arrangement by each saved reply while saves overlap, then seeds a fresh one', () => {
    const state = useOrderFailuresStore.getState()
    const confirmed = [{ id: 'a', order: 10 }, { id: 'b', order: 20 }]
    const saved = [{ id: 'b', order: 0 }, { id: 'a', order: 1 }]
    const older = state.beginAttempt('shelf:loose', confirmed)
    const newer = state.beginAttempt('shelf:loose', saved)
    const independent = state.beginAttempt('boxes', [{ id: 'box', order: 40 }])

    expect(state.confirmedOrder('shelf:loose')).toEqual(confirmed)
    // A failed reply leaves the base; a saved one becomes it.
    state.finishAttempt('shelf:loose', newer, null)
    expect(state.confirmedOrder('shelf:loose')).toEqual(confirmed)
    state.finishAttempt('boxes', independent, [{ id: 'box', order: 2 }])
    const third = state.beginAttempt('shelf:loose', [])
    state.finishAttempt('shelf:loose', older, saved)
    expect(state.confirmedOrder('shelf:loose')).toEqual(expect.arrayContaining(saved))
    expect(state.confirmedOrder('shelf:loose')).toHaveLength(saved.length)
    state.finishAttempt('shelf:loose', third, null)
    expect(useOrderFailuresStore.getState().pending).toEqual({})

    const fresh = [{ id: 'a', order: 8 }, { id: 'b', order: 9 }]
    const next = state.beginAttempt('shelf:loose', fresh)
    expect(state.confirmedOrder('shelf:loose')).toEqual(fresh)
    state.finishAttempt('shelf:loose', next, fresh)
    expect(useOrderFailuresStore.getState().pending).toEqual({})
  })
})
