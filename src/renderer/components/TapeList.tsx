import { useEffect, useRef, useState } from 'react'
import { ipcOn } from '@renderer/ipc/client'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { useTapeListboxKeyboard } from '@renderer/lib/useTapeListboxKeyboard'
import { TapeRow } from './TapeRow'
import { useI18n } from '@renderer/i18n/I18nContext'

/**
 * The Inbox: one continuous list, newest added first, with no chosen order to
 * drag. New tapes arrive at the top and the list scrolls up to reveal them. The
 * order that backs the view, keyboard navigation and removal lives in
 * lib/tapeOrder so they agree on which tape is next.
 */
export function TapeList() {
  const selectedId = useSelectionStore((s) => s.selectedId)
  const filter = useFilterStore((s) => s.filter)
  const visible = useVisibleTapes()
  const t = useI18n()

  const kb = useTapeListboxKeyboard<HTMLUListElement>(visible, selectedId)

  // Scroll the newly-added tape into view. New tapes land at the top, so a top
  // sentinel + scrollIntoView('nearest') reveals them when the list is scrolled
  // down and does nothing when the top is already showing. Adds come in over the
  // tapes:added event; the tick defers the scroll to after the new row renders.
  const topRef = useRef<HTMLDivElement>(null)
  const [addTick, setAddTick] = useState(0)
  useEffect(
    () =>
      ipcOn('tapes:added', (added) => {
        if (added.some((t) => !t.shelved)) setAddTick((n) => n + 1)
      }),
    [],
  )
  useEffect(() => {
    if (addTick > 0) topRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [addTick])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="p-6 text-sm text-fg">{t.t(filter === 'archived' ? 'tapes.emptyArchived' : 'tapes.emptyInbox')}</div>
        ) : (
          <>
            <div ref={topRef} />
            <ul
              ref={kb.ref}
              {...kb.listboxProps}
              role="listbox"
              aria-label={t.t('tapes.label')}
              className="space-y-1.5 p-3 outline-none"
            >
              {visible.map((tape) => (
                <li key={tape.id} role="presentation">
                  <TapeRow
                    tape={tape}
                    selected={tape.id === selectedId}
                    id={kb.optionId(tape.id)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
