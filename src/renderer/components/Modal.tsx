import { useId, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { trapTabFocus } from '@renderer/lib/focusTrap'
import { acquireScrollLock, releaseScrollLock } from '@renderer/lib/scrollLock'

/**
 * Three tiers, by content:
 *   md  — prompts & short forms (Confirm, About, Shortcuts)
 *   2xl — data-dense panels (Settings, Scan-a-page, Required-tools, Rename, Export)
 *   4xl — wide side-by-side comparisons (Refresh metadata: current vs new)
 */
type ModalSize = 'md' | '2xl' | '4xl'

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
  '4xl': 'max-w-5xl',
}

/**
 * Shared chrome for every in-app modal: backdrop, pinned header with a close ✕,
 * scrollable body, optional pinned footer. The shell owns the mechanics every
 * modal inherits:
 *   - all close paths (Escape, backdrop click, ✕) funnel through onClose;
 *   - Escape closes only the topmost dialog, so stacked modals unwind one at a time;
 *   - focus lands on the dialog on open, is trapped inside while open (Tab/Shift+Tab
 *     wrap; stray focus is pulled back), and returns to the opener on close;
 *   - background scrolling is locked while any modal is open;
 *   - the title is the accessible name via aria-labelledby.
 * Feature modals supply only their content, footer actions, and close logic.
 */
export function Modal({ title, onClose, children, footer, size = 'md', fitContent = false, closeDisabled = false }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  // Focus containment + scroll lock for the modal's lifetime. Mount-only: the
  // open-time focus capture and the restore on close must each happen exactly
  // once. Escape and Tab are owned by the panel's onKeyDown below; this effect
  // adds focus-on-open, the focusin safety net, the scroll lock, and restore.
  useLayoutEffect(() => {
    const panel = panelRef.current
    const previouslyFocused = document.activeElement
    panel?.focus()
    acquireScrollLock()

    // Pull focus back if it slips out of the topmost modal through programmatic
    // moves or engine quirks (Tab itself is already contained by onKeyDown).
    function onFocusIn(e: FocusEvent) {
      if (!panel || !isTopmost(panel)) return
      if (e.target instanceof Node && panel.contains(e.target)) return
      panel.focus()
    }
    document.addEventListener('focusin', onFocusIn)

    return () => {
      document.removeEventListener('focusin', onFocusIn)
      releaseScrollLock()
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [])

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const panel = panelRef.current
    if (panel === null || !isTopmost(panel)) return
    if (e.key === 'Escape') {
      // The topmost modal owns Escape: swallow it so it never reaches a window-
      // level shortcut, then close unless a busy action holds the modal open.
      e.stopPropagation()
      if (!closeDisabled) onClose()
      return
    }
    if (e.key === 'Tab') {
      trapTabFocus(panel, e.nativeEvent)
    }
  }

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
        aria-labelledby={titleId}
        tabIndex={-1}
        data-dialog-surface
        onKeyDown={onKeyDown}
        className={`flex max-h-[85vh] ${fitContent ? 'w-fit' : 'w-full'} ${SIZE_CLASS[size]} flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl focus:outline-hidden`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-zinc-700 p-4">
          <h2 id={titleId} className="text-lg font-medium">{title}</h2>
          <button
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
            className="text-lg leading-none text-zinc-300 hover:text-zinc-100 disabled:opacity-40"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain p-6">{children}</div>

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
