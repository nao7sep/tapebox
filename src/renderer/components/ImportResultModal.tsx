import type { ImportResult } from '@shared/ipc-contract'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/ui'

type Props = { result: ImportResult; onClose: () => void }

/**
 * Blocking summary of an import: what entered the library and what was rejected
 * (with reasons). Shown after every import attempt so a sidecar-less file can't
 * silently vanish. Per-file — successes and failures are listed side by side.
 */
export function ImportResultModal({ result, onClose }: Props) {
  const { imported, rejected } = result

  const footer = (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  )

  return (
    <Modal title="Import results" onClose={onClose} size="md" footer={footer}>
      <div className="space-y-4">
        <section>
          <h3 className="mb-1 text-xs font-medium text-zinc-300">
            Imported ({imported.length})
          </h3>
          {imported.length === 0 ? (
            <p className="text-xs text-zinc-400">Nothing was imported.</p>
          ) : (
            <ul className="space-y-1">
              {imported.map((tape) => (
                <li key={tape.id} className="truncate text-sm text-zinc-100">
                  {tape.title ?? tape.filename ?? tape.sourceUrl}
                </li>
              ))}
            </ul>
          )}
        </section>

        {rejected.length > 0 && (
          <section className="rounded border border-red-900 bg-red-950/40 px-3 py-2">
            <h3 className="mb-1 text-xs font-medium text-red-300">
              Failed ({rejected.length})
            </h3>
            <ul className="space-y-1">
              {rejected.map((r) => (
                <li key={r.path} className="text-xs text-red-300">
                  <span className="text-red-200">{basename(r.path)}</span> — {r.reason}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
