import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { nextIndex } from '@renderer/lib/nextIndex'

/**
 * The app's in-app menu layer: a trigger plus a popup list of commands that
 * behaves like a real menu. The trigger is the single tab stop (aria-haspopup /
 * aria-expanded); opening moves focus into the menu and closing returns it to the
 * trigger; Up/Down move between items (stopping at the ends, like the app's lists),
 * Home/End jump to the ends, type-ahead jumps by label, Enter/Space activate, and
 * Escape / Tab / outside click close. Items are `menuitem`s navigated by the
 * arrows, never by Tab.
 *
 * Hand-rolled on the renderer's own focus helpers (no menu dependency), shared by
 * every dropdown so they behave identically.
 */
type TriggerProps = {
  ref: (el: HTMLButtonElement | null) => void
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  onClick: () => void
}

type Props = {
  label: string
  trigger: (props: TriggerProps) => ReactNode
  children: ReactNode
  align?: 'left' | 'right'
  placement?: 'top' | 'bottom'
  maxHeight?: number
  /** Overrides the default popup surface classes. Positioning stays with Menu. */
  contentClassName?: string
}

const MenuContext = createContext<{ close: () => void } | null>(null)

const VIEWPORT_PADDING = 8
const TRIGGER_GAP = 4

type PopupPosition = {
  left: number
  top: number
  maxHeight: number
}

export function Menu({
  label,
  trigger,
  children,
  align = 'right',
  placement = 'bottom',
  maxHeight,
  contentClassName,
}: Props) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<PopupPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const items = (): HTMLElement[] =>
    contentRef.current
      ? Array.from(contentRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      : []

  const close = (focusTrigger = true) => {
    setOpen(false)
    setPosition(null)
    if (focusTrigger) triggerRef.current?.focus()
  }

  // The popup is portalled to the viewport so no pane scroller can clip it.
  // Position after the surface is rendered, then keep it attached to its trigger
  // while a window resize or ancestor scroll changes the available space.
  useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const triggerEl = triggerRef.current
      const contentEl = contentRef.current
      if (!triggerEl || !contentEl) return

      const triggerRect = triggerEl.getBoundingClientRect()
      const contentRect = contentEl.getBoundingClientRect()
      const desiredHeight = Math.min(
        contentEl.scrollHeight || contentRect.height,
        maxHeight ?? Number.POSITIVE_INFINITY,
      )
      const above = Math.max(0, triggerRect.top - TRIGGER_GAP - VIEWPORT_PADDING)
      const below = Math.max(
        0,
        window.innerHeight - triggerRect.bottom - TRIGGER_GAP - VIEWPORT_PADDING,
      )
      const preferredSpace = placement === 'top' ? above : below
      const oppositeSpace = placement === 'top' ? below : above
      const actualPlacement =
        desiredHeight > preferredSpace && oppositeSpace > preferredSpace
          ? placement === 'top'
            ? 'bottom'
            : 'top'
          : placement
      const availableHeight = actualPlacement === 'top' ? above : below
      const renderedHeight = Math.min(desiredHeight, availableHeight)
      const unclampedLeft =
        align === 'right' ? triggerRect.right - contentRect.width : triggerRect.left
      const maxLeft = Math.max(
        VIEWPORT_PADDING,
        window.innerWidth - contentRect.width - VIEWPORT_PADDING,
      )
      const left = Math.min(Math.max(unclampedLeft, VIEWPORT_PADDING), maxLeft)
      const top =
        actualPlacement === 'top'
          ? triggerRect.top - TRIGGER_GAP - renderedHeight
          : triggerRect.bottom + TRIGGER_GAP

      setPosition({ left, top, maxHeight: availableHeight })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition)
    if (triggerRef.current) observer?.observe(triggerRef.current)
    if (contentRef.current) observer?.observe(contentRef.current)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
      observer?.disconnect()
    }
  }, [align, maxHeight, open, placement])

  // On open, move focus into the menu (first item). On a re-render while open
  // (the item set changed), leave focus where it is.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => items()[0]?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Outside click closes without yanking focus back (a pointer interaction).
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (contentRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
      setPosition(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items()
    if (all.length === 0) return
    const current = Math.max(0, all.indexOf(document.activeElement as HTMLElement))
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      all[nextIndex(current, all.length, 1)]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      all[nextIndex(current, all.length, -1)]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      all[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      all[all.length - 1]?.focus()
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      close()
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase()
      const order = [...all.slice(current + 1), ...all.slice(0, current + 1)]
      order.find((el) => el.textContent?.trim().toLowerCase().startsWith(ch))?.focus()
    }
  }

  return (
    <div className="relative">
      {trigger({
        ref: (el) => {
          triggerRef.current = el
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        onClick: () => {
          setPosition(null)
          setOpen((v) => !v)
        },
      })}
      {open && createPortal(
        <div
          ref={contentRef}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={
            contentClassName ??
            'w-48 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl'
          }
          style={{
            position: 'fixed',
            zIndex: 40,
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            maxHeight: position
              ? Math.min(position.maxHeight, maxHeight ?? Number.POSITIVE_INFINITY)
              : maxHeight,
            maxWidth: `calc(100vw - ${VIEWPORT_PADDING * 2}px)`,
            overflowY: 'auto',
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          <MenuContext.Provider value={{ close }}>{children}</MenuContext.Provider>
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * One command in a {@link Menu}. A `menuitem` that is reachable only by the
 * menu's arrow navigation (never its own tab stop); activating it runs the action
 * and closes the menu, returning focus to the trigger.
 */
export function MenuItem({
  onSelect,
  children,
  className,
}: {
  onSelect: () => void
  children: ReactNode
  className?: string
}) {
  const ctx = useContext(MenuContext)
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => {
        ctx?.close()
        onSelect()
      }}
      // The arrow-focused item is the menu's cursor: give it the app's highlight
      // (a background, like the lists' selection) and suppress the default ring,
      // which an `overflow` container otherwise clips into stray edges.
      className={
        'outline-none focus:bg-zinc-800 focus:text-zinc-100 ' +
        (className ??
          'block w-full px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100')
      }
    >
      {children}
    </button>
  )
}
