import { Modal } from '@renderer/components/Modal'

const SHORTCUTS: { label: string; keys: string }[] = [
  { label: 'Add the URL in the input', keys: 'Enter' },
  { label: 'Close a modal', keys: 'Esc' },
]

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="md">
      <div className="space-y-2 text-sm">
        {SHORTCUTS.map((s) => (
          <div key={s.label} className="flex items-center justify-between">
            <span className="text-zinc-300">{s.label}</span>
            <kbd className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200">{s.keys}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  )
}
