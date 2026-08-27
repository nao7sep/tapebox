import type { ImportIssue } from '@shared/ipc-contract'

export type ExternalFileOffer = 'rejected' | 'delivery-only'

type FileOfferTransfer = {
  types: Iterable<string> | ArrayLike<string>
  items: Iterable<Pick<DataTransferItem, 'kind'>> | ArrayLike<Pick<DataTransferItem, 'kind'>>
}

export function isTextEditingDropTarget(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(
    "textarea, [contenteditable='true'], input:not([type]), input[type='text'], input[type='search'], input[type='url'], input[type='email'], input[type='number'], input[type='password'], input[type='tel']",
  ))
}

/** Finder and Explorer may protect file details until release. Any file offer is
 * therefore deliverable; product admission happens from host paths at drop time. */
export function inspectExternalFileOffer(
  dataTransfer: FileOfferTransfer,
): ExternalFileOffer {
  const items = Array.from(dataTransfer.items)
  const hasFiles = Array.from(dataTransfer.types).includes('Files') ||
    items.some((item) => item.kind === 'file')
  return hasFiles ? 'delivery-only' : 'rejected'
}

export interface DroppedPathResolution {
  paths: string[]
  issues: ImportIssue[]
  errors: { fileName: string; error: unknown }[]
}

/** Stable before host-path resolution, so retrying the same native offer can
 * resolve its earlier path-boundary failure without clearing another drop. */
export function droppedFileOperationKey(
  files: Iterable<File> | ArrayLike<File>,
): string {
  const identities = [...new Set(Array.from(files)
    .map((file) => JSON.stringify([file.name, file.size, file.lastModified, file.type])))]
    .sort()
  return `drop:${JSON.stringify(identities)}`
}

/** Resolve every delivered file to its host-authoritative path. Literal repeats
 * and inaccessible offers are accounted for instead of disappearing silently. */
export function resolveDroppedPaths(
  files: Iterable<File> | ArrayLike<File>,
  resolvePath: (file: File) => string,
): DroppedPathResolution {
  const delivered = Array.from(files)
  const paths: string[] = []
  const seen = new Set<string>()
  const issues: ImportIssue[] = []
  const errors: DroppedPathResolution['errors'] = []

  if (delivered.length === 0) {
    issues.push({
      path: 'Dropped files',
      reason: 'The dropped items were not available as local files.',
      severity: 'warning',
    })
  }

  for (const file of delivered) {
    try {
      const path = resolvePath(file)
      if (!path) {
        issues.push({
          path: file.name,
          reason: 'The file was not available as a local path.',
          severity: 'warning',
        })
      } else if (seen.has(path)) {
        issues.push({
          path,
          reason: 'This path was repeated in the same drop.',
          severity: 'information',
        })
      } else {
        seen.add(path)
        paths.push(path)
      }
    } catch (error) {
      issues.push({
        path: file.name,
        reason: 'The file could not be resolved as a local path.',
        severity: 'error',
      })
      errors.push({ fileName: file.name, error })
    }
  }

  return { paths, issues, errors }
}

type DenialEvent = {
  defaultPrevented: boolean
  target: EventTarget | null
  dataTransfer: FileOfferTransfer & { dropEffect: DataTransfer['dropEffect'] }
  preventDefault(): void
}

/** Prevent an unowned desktop-webview drop from navigating the window. This is
 * invisible and performs no import; real text editors retain ordinary text drops. */
export function denyUnhandledExternalDrop(event: DenialEvent): void {
  if (event.defaultPrevented) return
  const offer = inspectExternalFileOffer(event.dataTransfer)
  if (offer === 'rejected' && isTextEditingDropTarget(event.target)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'none'
}
