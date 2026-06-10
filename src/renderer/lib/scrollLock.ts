// Background scroll lock for the shared modal shell.
//
// Locked exactly once while ANY modal is open and restored only when the LAST
// one closes, so a confirmation stacked over a form (e.g. a discard prompt over
// Settings) never unlocks the page early. The shell acquires on mount and
// releases on unmount; the reference count coordinates stacked modals.
//
// `document.body`'s overflow is the lever: with no explicit overflow on the
// html element, the body's value propagates to the viewport in Chromium, so
// `hidden` here freezes the page behind the backdrop.

let lockCount = 0
let savedBodyOverflow: string | null = null

export function acquireScrollLock(): void {
  if (typeof document === 'undefined') return
  if (lockCount === 0) {
    savedBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount += 1
}

export function releaseScrollLock(): void {
  if (typeof document === 'undefined') return
  if (lockCount === 0) return
  lockCount -= 1
  if (lockCount === 0) {
    document.body.style.overflow = savedBodyOverflow ?? ''
    savedBodyOverflow = null
  }
}
