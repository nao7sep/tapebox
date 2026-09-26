import { describe, expect, it } from 'vitest'
import { downloadFailurePresentation } from '@renderer/lib/downloadFailure'
import { inEnglish } from '../../helpers/i18n'

describe('download failure presentation', () => {
  it('maps structured codes and legacy missing codes to authored copy', () => {
    expect(inEnglish(downloadFailurePresentation('duplicate'))).toContain('already in the library')
    expect(inEnglish(downloadFailurePresentation('download'))).toContain('could not be completed')
    expect(inEnglish(downloadFailurePresentation(undefined))).toContain('could not be completed')
  })

  it('has no channel for hostile persisted exception prose', () => {
    const hostileLegacyValue = 'EACCES Error invoking remote method IPC /private/tmp/HOSTILE-SENTINEL'
    const presentation = downloadFailurePresentation(undefined)
    expect(inEnglish(presentation)).not.toContain(hostileLegacyValue)
  })
})
