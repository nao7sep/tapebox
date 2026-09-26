import { useCallback, useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { pathForFile } from '@renderer/ipc/client'
import { log } from '@renderer/ipc/log'
import { useImportMedia } from '@renderer/lib/useImportMedia'
import {
  droppedFileOperationKey,
  inspectExternalFileOffer,
  resolveDroppedPaths,
} from '@renderer/lib/externalDrop'
import { useImportResultStore } from '@renderer/store/importResult'
import { describeError } from '@shared/error'
import { CloseIcon } from './Icon'
import { PassiveScrollRegion } from './PassiveScrollRegion'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message } from '@shared/i18n/translate'
import { ALREADY_IN_LIBRARY } from '@shared/import-issues'

export function TapeImportReceiver({ children }: { children: ReactNode }) {
  const [deliveryActive, setDeliveryActive] = useState(false)
  const importMedia = useImportMedia()

  const clearActive = useCallback(() => {
    setDeliveryActive(false)
  }, [])

  const showDelivery = useCallback(() => {
    setDeliveryActive(true)
  }, [])

  useEffect(() => {
    window.addEventListener('blur', clearActive)
    window.addEventListener('dragend', clearActive)
    return () => {
      window.removeEventListener('blur', clearActive)
      window.removeEventListener('dragend', clearActive)
    }
  }, [clearActive])

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (inspectExternalFileOffer(event.dataTransfer) === 'rejected') return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    showDelivery()
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'none'
    clearActive()

    if (inspectExternalFileOffer(event.dataTransfer) === 'rejected') {
      await importMedia([], [{
        path: message('drop.droppedContent'),
        reason: message('drop.notFiles'),
        severity: 'warning',
      }], { operationKey: 'drop', entryKey: 'drop' })
      return
    }

    const files = Array.from(event.dataTransfer.files)
    const attempt = files.length > 0
      ? { operationKey: droppedFileOperationKey(files), entryKey: 'drop' }
      : { operationKey: 'drop', entryKey: 'drop' }
    const resolved = resolveDroppedPaths(files, pathForFile)
    for (const failure of resolved.errors) {
      log.error('dropped file path resolution failed', {
        fileName: failure.fileName,
        error: describeError(failure.error),
      })
    }
    event.dataTransfer.dropEffect = 'copy'
    await importMedia(resolved.paths, resolved.issues, attempt)
  }

  return (
    <div
      data-drop-receiver="tape-collection"
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) clearActive()
      }}
      onDrop={(event) => void onDrop(event)}
      className={
        'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded ' +
        (deliveryActive ? 'bg-warning-drop ring-2 ring-inset ring-warning-ring' : '')
      }
    >
      {children}
      <ImportResultNotice />
    </div>
  )
}

function ImportResultNotice() {
  const result = useImportResultStore((state) => state.result)
  const clear = useImportResultStore((state) => state.clear)
  const t = useI18n()
  if (!result) return null

  const severity = result.issues.some((item) => item.severity === 'error')
    ? 'error'
    : result.issues.some((item) => item.severity === 'warning')
      ? 'warning'
      : 'information'
  const allDuplicates = result.issues.length > 0 &&
    result.issues.every((item) => item.reason.key === ALREADY_IN_LIBRARY)
  const added = result.imported.length
  const others = result.issues.length
  // Two counts in one line: each keeps its own plural form, and the pair entry
  // decides the order and punctuation.
  const lead = added > 0
    ? message('import.leadPair', {
        first: message(allDuplicates ? 'import.addedNew' : 'import.added', { count: added }),
        rest: message(allDuplicates ? 'import.alreadyThere' : 'import.notAdded', { count: others }),
      })
    : allDuplicates
      ? message('import.allDuplicates', { count: others })
      : message(severity === 'error' ? 'import.failed' : 'import.notImported')

  const palette = severity === 'error'
    ? 'border-danger-line-hover bg-danger-banner text-danger-fg-strong'
    : severity === 'warning'
      ? 'border-warning-line-hover bg-warning-banner text-warning-fg-strong'
      : 'border-info-line-hover bg-info-banner text-info-fg-strong'
  const detailColor = severity === 'error'
    ? 'text-danger-fg-strong/90'
    : severity === 'warning' ? 'text-warning-fg-strong/90' : 'text-info-fg-strong/90'
  const dismissColor = severity === 'error'
    ? 'text-danger-fg-strong hover:bg-danger-hover hover:text-danger-fg-strong'
    : severity === 'warning'
      ? 'text-warning-fg-strong hover:bg-warning-hover hover:text-warning-fg-strong'
      : 'text-info-fg-strong hover:bg-info-hover hover:text-info-fg-strong'

  return (
    <PassiveScrollRegion
      as="section"
      label={t.t('import.resultLabel')}
      role={severity === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
      className={`relative m-3 mt-0 max-h-[40%] shrink-0 overflow-y-auto rounded-md border py-2.5 pr-11 pl-3 shadow-sm ${palette}`}
    >
      <div className="min-w-0">
          <p className="text-sm font-semibold">{t.text(lead)}</p>
          <ul className={`mt-1.5 space-y-1 text-xs ${detailColor}`}>
            {result.issues.map((item, index) => (
              <li key={index}>
                {t.rich('import.issue', {
                  name: <span className="font-medium">{typeof item.path === 'string' ? basename(item.path) : t.text(item.path)}</span>,
                  reason: t.text(item.reason),
                })}
              </li>
            ))}
          </ul>
        <button
          type="button"
          onClick={clear}
          aria-label={t.t('import.closeResult')}
          className={`absolute top-1.5 right-2 grid h-7 w-7 place-items-center rounded border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-1 ${dismissColor}`}
        >
          <CloseIcon />
        </button>
      </div>
    </PassiveScrollRegion>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
