import type { ReactNode } from 'react'

type Kind = 'error' | 'warning'

/**
 * A bordered panel with a caption strip divided from the body by a rule — the
 * shared shape behind the failed-download pane (error) and the page-of-videos
 * notice (warning), so their structure and colors stay in lockstep
 * with the app's other red/amber surfaces.
 *
 * `fill` makes the panel grow to fill the available height; the body controls
 * its own padding and scroll (a short notice vs. a scrollable failure log).
 */
const KIND: Record<Kind, { box: string; divider: string; caption: string }> = {
  error:   { box: 'border-red-900 bg-red-950/40',     divider: 'border-red-900',   caption: 'text-red-300' },
  warning: { box: 'border-amber-900 bg-amber-950/40', divider: 'border-amber-900', caption: 'text-amber-300' },
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
        'mx-4 mt-3 flex flex-col overflow-hidden rounded border ' +
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
