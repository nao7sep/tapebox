import { useState } from 'react'
import type { Item } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/ui'
import { INPUT_CLASS } from '@renderer/components/ui/input-styles'

type Props = {
  item: Item
  onClose: () => void
}

/**
 * Rename the on-disk media + sidecar to a slug. AI button calls
 * ai:generateSlug to seed the input; user can edit before applying.
 * Collisions / invalid slugs / missing AI config show as inline errors.
 */
export function RenameModal({ item, onClose }: Props) {
  const [slug, setSlug] = useState(item.slug ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'generate' | 'apply' | null>(null)

  async function generate() {
    setError(null)
    setBusy('generate')
    try {
      const result = await ipcInvoke('ai:generateSlug', { itemId: item.id })
      setSlug(result.slug)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    setError(null)
    setBusy('apply')
    try {
      await ipcInvoke('library:renameToSlug', { itemId: item.id, slug })
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy !== null}>Cancel</Button>
      <Button
        variant="primary"
        onClick={() => void apply()}
        disabled={busy !== null || !slug.trim()}
      >
        {busy === 'apply' ? 'Renaming…' : 'Rename'}
      </Button>
    </>
  )

  return (
    <Modal title="Rename to slug" onClose={onClose} size="md" footer={footer} closeDisabled={busy !== null}>
      <p className="-mt-2 mb-4 truncate text-xs text-zinc-400">
        Current: <span className="text-zinc-300">{item.filename ?? '—'}</span>
      </p>

      <div className="space-y-2">
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="lowercase-kebab-slug"
          spellCheck={false}
          className={`w-full ${INPUT_CLASS}`}
        />
        <Button variant="ghost" size="sm" onClick={() => void generate()} disabled={busy !== null}>
          {busy === 'generate' ? 'Generating…' : '✨ Generate with AI'}
        </Button>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
    </Modal>
  )
}
