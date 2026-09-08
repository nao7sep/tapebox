import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

const LINE_SCROLL_PX = 40

export interface PassiveScrollPlanInput {
  key: string
  shiftKey: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function planPassiveScrollTop({
  key,
  shiftKey,
  scrollTop,
  scrollHeight,
  clientHeight,
}: PassiveScrollPlanInput): number | null {
  const maximum = Math.max(0, scrollHeight - clientHeight)
  if (maximum === 0) return null

  let requested: number
  switch (key) {
    case 'ArrowUp':
      requested = scrollTop - LINE_SCROLL_PX
      break
    case 'ArrowDown':
      requested = scrollTop + LINE_SCROLL_PX
      break
    case 'PageUp':
      requested = scrollTop - clientHeight
      break
    case 'PageDown':
      requested = scrollTop + clientHeight
      break
    case 'Home':
      requested = 0
      break
    case 'End':
      requested = maximum
      break
    case ' ':
      requested = scrollTop + clientHeight * (shiftKey ? -1 : 1)
      break
    default:
      return null
  }

  return Math.min(maximum, Math.max(0, requested))
}

export function handlePassiveScrollKey(event: ReactKeyboardEvent<HTMLElement>): void {
  if (
    event.defaultPrevented ||
    event.target !== event.currentTarget ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.nativeEvent.isComposing
  ) {
    return
  }

  const owner = event.currentTarget
  const next = planPassiveScrollTop({
    key: event.key,
    shiftKey: event.shiftKey,
    scrollTop: owner.scrollTop,
    scrollHeight: owner.scrollHeight,
    clientHeight: owner.clientHeight,
  })
  if (next === null) return

  event.preventDefault()
  event.stopPropagation()
  owner.scrollTop = next
}
