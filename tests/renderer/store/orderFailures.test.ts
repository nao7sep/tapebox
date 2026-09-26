import { beforeEach, describe, expect, it } from 'vitest'

import { useOrderFailuresStore } from '@renderer/store/orderFailures'
import type { Message } from '@shared/i18n/translate'

// Opaque stand-ins: the store keeps whatever message it is given.
const note = (name: string) => ({ key: name }) as unknown as Message

beforeEach(() => {
  useOrderFailuresStore.setState({ inbox: null, boxes: null, archiveTapes: {} })
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
})
