import { describe, expect, it } from 'vitest'
import { tapeStatusLabel } from '@renderer/lib/tapeStatus'
import type { Tape } from '@shared/domain'
import { inEnglish } from '../../helpers/i18n'

const downloading = { state: 'downloading' } as Tape

describe('tapeStatusLabel', () => {
  it('says a stalled download has made no progress', () => {
    expect(inEnglish(tapeStatusLabel(downloading, { phase: 'downloading', percent: 42 }, true)))
      .toBe('Downloading 42% · no progress for 2 min')
  })

  it('shows plain progress otherwise, and ignores a stale stall flag once the tape settles', () => {
    expect(inEnglish(tapeStatusLabel(downloading, { phase: 'downloading', percent: 42 }))).toBe('Downloading 42%')
    expect(inEnglish(tapeStatusLabel({ state: 'paused' } as Tape, undefined, true))).toBe('Paused')
  })
})
