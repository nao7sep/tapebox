import { beforeEach, describe, expect, it } from 'vitest'

import { useOrderFailuresStore } from '@renderer/store/orderFailures'
import type { Message } from '@shared/i18n/translate'

// Opaque stand-ins: the store keeps whatever message it is given.
const note = (name: string) => ({ key: name }) as unknown as Message

beforeEach(() => {
  useOrderFailuresStore.setState({ inbox: null, boxes: null, archiveTapes: {}, attempts: {} })
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
    const inbox = state.beginAttempt('inbox')
    const boxes = state.beginAttempt('boxes')
    const unboxed = state.beginAttempt('archive:unboxed')
    const boxA = state.beginAttempt('archive:box:a')
    const boxB = state.beginAttempt('archive:box:b')
    const newerBoxA = state.beginAttempt('archive:box:a')

    expect(state.isCurrentAttempt('inbox', inbox)).toBe(true)
    expect(state.isCurrentAttempt('boxes', boxes)).toBe(true)
    expect(state.isCurrentAttempt('archive:unboxed', unboxed)).toBe(true)
    expect(state.isCurrentAttempt('archive:box:a', boxA)).toBe(false)
    expect(state.isCurrentAttempt('archive:box:a', newerBoxA)).toBe(true)
    expect(state.isCurrentAttempt('archive:box:b', boxB)).toBe(true)
    expect(useOrderFailuresStore.getState().inbox).toEqual(note('Inbox failed'))
  })
})
