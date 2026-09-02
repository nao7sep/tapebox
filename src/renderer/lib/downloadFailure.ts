import type { TapeFailureCode } from '@shared/domain'

/** Map durable failure facts to renderer-authored copy. */
export function downloadFailurePresentation(code: TapeFailureCode | null | undefined): string {
  if (code === 'duplicate') {
    return 'This video is already in the library, so it was not downloaded again.'
  }
  return 'The download could not be completed. Check the source and your connection, then try again.'
}
