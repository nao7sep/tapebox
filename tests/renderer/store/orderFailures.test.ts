import { beforeEach, describe, expect, it } from 'vitest'

import { useOrderFailuresStore } from '@renderer/store/orderFailures'

beforeEach(() => {
  useOrderFailuresStore.setState({ inbox: null, boxes: null, archiveTapes: {} })
})

describe('order failure ownership', () => {
  it('retains independent inbox, box-list, and per-box tape-list failures', () => {
    const state = useOrderFailuresStore.getState()
    state.setInbox('Inbox failed')
    state.setBoxes('Boxes failed')
    state.setArchiveTapes('box:a', 'Box A tapes failed')
    state.setArchiveTapes('box:b', 'Box B tapes failed')

    expect(useOrderFailuresStore.getState()).toMatchObject({
      inbox: 'Inbox failed',
      boxes: 'Boxes failed',
      archiveTapes: {
        'box:a': 'Box A tapes failed',
        'box:b': 'Box B tapes failed',
      },
    })
  })

  it('clears only the matching list failure', () => {
    const state = useOrderFailuresStore.getState()
    state.setArchiveTapes('box:a', 'Box A tapes failed')
    state.setArchiveTapes('box:b', 'Box B tapes failed')
    state.setArchiveTapes('box:a', null)

    expect(useOrderFailuresStore.getState().archiveTapes).toEqual({
      'box:b': 'Box B tapes failed',
    })
  })
})
