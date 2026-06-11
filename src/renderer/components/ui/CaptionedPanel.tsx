import type { ReactNode } from 'react'

type Kind = 'error' | 'warning' | 'info' | 'neutral'

/**
 * A bordered panel with a caption strip divided from the body by a rule. Its
 * colour carries the same meaning as everywhere else in the app, so a state's
 * row tint and its detail panel always agree:
 *   error   (red)    — a failure (failed download)
 *   warning (amber)  — stopped but recoverable (paused)
 *   info    (violet) — a list page to resolve, not a problem (page of videos)
 *   neutral (zinc)   — work in progress / settled (download log)
 *
 * `fill` makes the panel grow to fill the available height; the body controls
 * its own padding and scroll (a short notice vs. a scrollable failure log).
 *
 * The panel carries its own margins (mx-4 for the side gutters, my-3 top and
 * bottom) so it sits evenly between the header rule above and the button-row
 * separator below — a `fill` panel would otherwise grow flush against that
 * separator with no breathing room.
 */
const KIND: Record<Kind, { box: string; divider: string; caption: string }> = {
  error:   { box: 'border-red-900 bg-red-950/40',       divider: 'border-red-900',    caption: 'text-red-300' },
  warning: { box: 'border-amber-900 bg-amber-950/40',   divider: 'border-amber-900',  caption: 'text-amber-300' },
  info:    { box: 'border-violet-900 bg-violet-950/40', divider: 'border-violet-900', caption: 'text-violet-300' },
  neutral: { box: 'border-zinc-700 bg-zinc-900/40',     divider: 'border-zinc-700',   caption: 'text-zinc-300' },
}

export function CaptionedPanel({
  kind,
  caption,
  fill,
  children,
}: {
  kind: Kind
  caption: string
  fill?: boolean
  children: ReactNode
}) {
  const c = KIND[kind]
  return (
    <div
      className={
        'mx-4 my-3 flex flex-col overflow-hidden rounded border ' +
        c.box +
        (fill ? ' min-h-0 flex-1' : '')
      }
    >
      <div className={`shrink-0 border-b px-3 py-2 text-sm font-medium ${c.divider} ${c.caption}`}>
        {caption}
      </div>
      {children}
    </div>
  )
}
