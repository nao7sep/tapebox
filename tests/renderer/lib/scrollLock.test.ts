// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { acquireScrollLock, releaseScrollLock } from '@renderer/lib/scrollLock'

// scrollLock keeps a module-global reference count. Each test balances its own
// acquire/release; `held` lets afterEach drain anything a failed assertion left
// behind so a leaked lock can't bleed into the next test.
let held = 0
function acquire(): void {
  acquireScrollLock()
  held += 1
}
function release(): void {
  releaseScrollLock()
  held -= 1
}

afterEach(() => {
  while (held > 0) release()
  document.body.style.overflow = ''
})

describe('background scroll lock', () => {
  it('locks on the first modal and restores the prior value only when the last closes', () => {
    document.body.style.overflow = 'scroll'

    acquire()
    expect(document.body.style.overflow).toBe('hidden')

    // A stacked modal must not re-lock or unlock; the page stays locked.
    acquire()
    expect(document.body.style.overflow).toBe('hidden')

    release()
    expect(document.body.style.overflow).toBe('hidden')

    release()
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('restores to no inline overflow when none was set before locking', () => {
    expect(document.body.style.overflow).toBe('')

    acquire()
    expect(document.body.style.overflow).toBe('hidden')

    release()
    expect(document.body.style.overflow).toBe('')
  })
})
