import { beforeEach, describe, expect, it } from 'vitest'

import { useOrderFailuresStore } from '@renderer/store/orderFailures'
import type { Message } from '@shared/i18n/translate'

// Opaque stand-ins: the store keeps whatever message it is given.
const note = (name: string) => ({ key: name }) as unknown as Message

beforeEach(() => {
  useOrderFailuresStore.setState({ inbox: null, boxes: null, archiveTapes: {}, attempts: {}, pending: {} })
})

describe('order failure ownership', () => {
  it('retains independent inbox, box-list, and per-box tape-list failures', () => {
    const state = useOrderFailuresStore.getState()
    state.setInbox(note('Inbox failed'))
    state.setBoxes(note('Boxes failed'))
    state.setArchiveTapes('box:a', note('Box A tapes failed'))
    state.setArchiveTapes('box:b', note('Box B tapes failed'))

    expect(useOrderFailuresStore.getState()).toMatchObject({
      inbox: note('Inbox failed'),
      boxes: note('Boxes failed'),
      archiveTapes: {
        'box:a': note('Box A tapes failed'),
        'box:b': note('Box B tapes failed'),
      },
    })
  })

  it('clears only the matching list failure', () => {
    const state = useOrderFailuresStore.getState()
    state.setArchiveTapes('box:a', note('Box A tapes failed'))
    state.setArchiveTapes('box:b', note('Box B tapes failed'))
    state.setArchiveTapes('box:a', null)

    expect(useOrderFailuresStore.getState().archiveTapes).toEqual({
      'box:b': note('Box B tapes failed'),
    })
  })

  it('supersedes only a later attempt for the same list without clearing retained results', () => {
    const state = useOrderFailuresStore.getState()
    state.setInbox(note('Inbox failed'))
    const inbox = state.beginAttempt('inbox', [])
    const boxes = state.beginAttempt('boxes', [])
    const unboxed = state.beginAttempt('archive:unboxed', [])
    const boxA = state.beginAttempt('archive:box:a', [])
    const boxB = state.beginAttempt('archive:box:b', [])
    const newerBoxA = state.beginAttempt('archive:box:a', [])

    expect(state.isCurrentAttempt('inbox', inbox)).toBe(true)
    expect(state.isCurrentAttempt('boxes', boxes)).toBe(true)
    expect(state.isCurrentAttempt('archive:unboxed', unboxed)).toBe(true)
    expect(state.isCurrentAttempt('archive:box:a', boxA)).toBe(false)
    expect(state.isCurrentAttempt('archive:box:a', newerBoxA)).toBe(true)
    expect(state.isCurrentAttempt('archive:box:b', boxB)).toBe(true)
    expect(useOrderFailuresStore.getState().inbox).toEqual(note('Inbox failed'))
  })

  it('advances the confirmed arrangement by each saved reply while saves overlap, then seeds a fresh one', () => {
    const state = useOrderFailuresStore.getState()
    const confirmed = [{ id: 'a', order: 10 }, { id: 'b', order: 20 }]
    const saved = [{ id: 'b', order: 0 }, { id: 'a', order: 1 }]
    const older = state.beginAttempt('inbox', confirmed)
    const newer = state.beginAttempt('inbox', saved)
    const independent = state.beginAttempt('boxes', [{ id: 'box', order: 40 }])

    expect(state.confirmedOrder('inbox')).toEqual(confirmed)
    // A failed reply leaves the base; a saved one becomes it.
    state.finishAttempt('inbox', newer, null)
    expect(state.confirmedOrder('inbox')).toEqual(confirmed)
    state.finishAttempt('boxes', independent, [{ id: 'box', order: 2 }])
    const third = state.beginAttempt('inbox', [])
    state.finishAttempt('inbox', older, saved)
    expect(state.confirmedOrder('inbox')).toEqual(expect.arrayContaining(saved))
    expect(state.confirmedOrder('inbox')).toHaveLength(saved.length)
    state.finishAttempt('inbox', third, null)
    expect(useOrderFailuresStore.getState().pending).toEqual({})

    const fresh = [{ id: 'a', order: 8 }, { id: 'b', order: 9 }]
    const next = state.beginAttempt('inbox', fresh)
    expect(state.confirmedOrder('inbox')).toEqual(fresh)
    state.finishAttempt('inbox', next, fresh)
    expect(useOrderFailuresStore.getState().pending).toEqual({})
  })
})
