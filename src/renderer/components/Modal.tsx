import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Two tiers, by content:
 *   md  — prompts & short forms (Confirm, About, Shortcuts, Export, Rename)
 *   2xl — data-dense panels (Settings, Add-playlist, Required-tools)
 */
type ModalSize = 'md' | '2xl'

type ModalProps = {
  title: string
  onClose: () => void
  children: ReactNode
  /** Action buttons. Rendered right-aligned, so the primary action goes last. */
  footer?: ReactNode
  /** Upper bound on width. The panel fills this unless fitContent shrinks it. */
  size?: ModalSize
  /** Size the panel to its content (capped by size) instead of always filling size. */
  fitContent?: boolean
  /** Block Esc / backdrop / ✕ while a non-interruptible action runs (e.g. install). */
  closeDisabled?: boolean
}

const SIZE_CLASS: Record<ModalSize, string> = {
  md: 'max-w-md',
  '2xl': 'max-w-3xl',
}

/**
 * Shared chrome for every in-app modal: backdrop, pinned header with a close ✕,
 * scrollable body, optional pinned footer. All close paths — Escape, backdrop
 * click, and the ✕ — funnel through onClose. Escape only closes the topmost
 * dialog so stacked modals unwind one at a time.
 */
export function Modal({ title, onClose, children, footer, size = 'md', fitContent = false, closeDisabled = false }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !isTopmost(panelRef.current)) return
      e.preventDefault()
      if (!closeDisabled) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, closeDisabled])

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (!closeDisabled && e.target === e.currentTarget) onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        data-dialog-surface
        className={`flex max-h-[85vh] ${fitContent ? 'w-fit' : 'w-full'} ${SIZE_CLASS[size]} flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-700 p-4">
          <h2 className="text-base font-medium">{title}</h2>
          <button
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
            className="text-lg leading-none text-zinc-300 hover:text-zinc-100 disabled:opacity-40"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-6">{children}</div>

        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-700 p-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

/** True when this panel is the last-opened dialog surface in the DOM. */
function isTopmost(panel: HTMLElement | null): boolean {
  if (!panel) return false
  const surfaces = document.querySelectorAll('[data-dialog-surface]')
  return surfaces[surfaces.length - 1] === panel
}
