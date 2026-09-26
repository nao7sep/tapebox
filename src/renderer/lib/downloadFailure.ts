import type { TapeFailureCode } from '@shared/domain'
import { message, type Message } from '@shared/i18n/translate'

/** Map durable failure facts to renderer-authored copy. */
export function downloadFailurePresentation(code: TapeFailureCode | null | undefined): Message {
  if (code === 'duplicate') {
    return message('download.duplicate')
  }
  return message('download.failed')
}
