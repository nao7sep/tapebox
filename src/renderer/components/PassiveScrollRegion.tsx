import type { HTMLAttributes, ReactNode } from 'react'
import { handlePassiveScrollKey } from '@renderer/lib/passiveScroll'

type PassiveScrollRegionProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section'
  label: string
  children: ReactNode
}

/**
 * One keyboard-reachable owner for passive, document-like overflow.
 *
 * The shared handler makes document keys deterministic and contains them at a
 * nested region's boundaries. Lists and grids deliberately do not use this
 * wrapper; their composite owners keep selection and navigation semantics.
 */
export function PassiveScrollRegion({
  as: Element = 'div',
  label,
  children,
  onKeyDown,
  ...props
}: PassiveScrollRegionProps) {
  return (
    <Element
      {...props}
      aria-label={label}
      data-passive-scroll-region
      tabIndex={0}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        handlePassiveScrollKey(event)
      }}
    >
      {children}
    </Element>
  )
}
