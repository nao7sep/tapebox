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
import { isComposingKeyboardEvent, useComposing } from '@renderer/lib/useComposing'

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
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
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
/** A menu is as wide as its longest item up to this cap (composite-control-
 * conventions): every command fits in the longest interface language, so only
 * box names reach it, and they end in an ellipsis; the box list holds them whole. */
export const MENU_MAX_WIDTH = '20rem'
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
  const positioned = position !== null
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const initialEdge = useRef<'first' | 'last'>('first')
  const { composingRef, handlers: composing } = useComposing()

  const items = (): HTMLButtonElement[] =>
    contentRef.current
      ? Array.from(contentRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]'))
          .filter((item) => !item.disabled)
      : []

  const focusInitialItem = () => {
    const all = items()
    const target = all.find((item) => item.getAttribute('aria-checked') === 'true')
      ?? (initialEdge.current === 'last' ? all.at(-1) : all[0])
    target?.focus()
  }

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

  // Navigation is ready once the popup is visible, before another key can arrive. Selected
  // choices take precedence over command-menu entry from the first/last edge.
  // Later renders leave focus alone, and hover never changes it.
  useLayoutEffect(() => {
    if (!open) {
      composingRef.current = false
      return
    }
    if (positioned) focusInitialItem()
  }, [open, positioned])

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
    if (isComposingKeyboardEvent(composingRef, e)) {
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault()
      return
    }
    const all = items()
    if (all.length === 0) return
    const current = Math.max(0, all.indexOf(document.activeElement as HTMLButtonElement))
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
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      all[current]?.click()
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
          initialEdge.current = 'first'
          setPosition(null)
          setOpen((v) => !v)
        },
        onKeyDown: (event) => {
          if (isComposingKeyboardEvent(composingRef, event)) {
            if (event.key === 'Enter' || event.key === ' ') event.preventDefault()
            return
          }
          if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return
          event.preventDefault()
          initialEdge.current = event.key === 'ArrowUp' ? 'last' : 'first'
          if (open) focusInitialItem()
          else {
            setPosition(null)
            setOpen(true)
          }
        },
      })}
      {open && createPortal(
        <div
          ref={contentRef}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          {...composing}
          className={
            contentClassName ??
            'w-max min-w-[12rem] rounded-md border border-line bg-panel py-1 shadow-xl'
          }
          style={{
            position: 'fixed',
            zIndex: 40,
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            maxHeight: position
              ? Math.min(position.maxHeight, maxHeight ?? Number.POSITIVE_INFINITY)
              : maxHeight,
            maxWidth: `min(${MENU_MAX_WIDTH}, calc(100vw - ${VIEWPORT_PADDING * 2}px))`,
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
  selected,
  disabled = false,
}: {
  onSelect: () => void
  children: ReactNode
  className?: string
  /** A persistent choice, distinct from the item keyboard navigation targets. */
  selected?: boolean
  disabled?: boolean
}) {
  const ctx = useContext(MenuContext)
  return (
    <button
      type="button"
      role={selected === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={selected}
      disabled={disabled}
      tabIndex={-1}
      onClick={() => {
        ctx?.close()
        onSelect()
      }}
      // Native :focus-visible keeps pointer entry quiet, then marks keyboard use.
      // The app's focus outline is inset to survive the popup's scrolling/clipping;
      // it remains distinct from hover and any persistent choice checkmark.
      className={
        'mx-1 block w-[calc(100%-0.5rem)] rounded px-3 py-1.5 text-left text-sm text-fg whitespace-nowrap overflow-hidden text-ellipsis hover:bg-raised hover:text-fg-strong focus-visible:bg-raised focus-visible:text-fg-strong focus-visible:outline-offset-[-2px] disabled:opacity-40 ' +
        (className ?? '')
      }
    >
      {children}
    </button>
  )
}
