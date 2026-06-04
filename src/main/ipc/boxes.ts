import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { log } from '@main/io/logger'
import { boxNameError, uniqueBoxName } from '@shared/box-names'
import type { Box, Tape } from '@shared/domain'

/**
 * Organization of archived tapes into boxes. A box is a named, ordered list; a
 * tape belongs to one box (Tape.boxId) or to Loose. Box membership and
 * within-box order live on the tapes; the box list itself is in the session.
 */
export function registerBoxHandlers(): void {
  handle('boxes:list', async () => session.getBoxes())

  handle('boxes:create', async ({ name }) => {
    const boxes = session.getBoxes()
    const order = boxes.reduce((max, g) => Math.max(max, g.order), -1) + 1
    // Seed with a unique, non-reserved name so the inline edit that follows
    // always starts from a valid name the user can overtype.
    const finalName = uniqueBoxName(name.trim() || 'New box', boxes.map((g) => g.name))
    const box: Box = { id: nanoid(10), name: finalName, order }
    session.upsertBox(box)
    emit('boxes:changed', session.getBoxes())
    log.info('archive: box created', { id: box.id, name: box.name })
    return box
  })

  handle('boxes:rename', async ({ boxId, name }) => {
    const boxes = session.getBoxes()
    const box = boxes.find((g) => g.id === boxId)
    if (!box) throw new Error(`Box not found: ${boxId}`)
    const trimmed = name.trim()
    if (!trimmed) return box // empty = no-op, keep the current name
    // Authoritative guard; the renderer validates inline, but main is the
    // source of truth (reserved words + case-insensitive uniqueness).
    const err = boxNameError(trimmed, boxes.filter((g) => g.id !== boxId).map((g) => g.name))
    if (err) throw new Error(err)
    const updated = { ...box, name: trimmed }
    session.upsertBox(updated)
    emit('boxes:changed', session.getBoxes())
    return updated
  })

  handle('boxes:delete', async ({ boxId }) => {
    session.removeBox(boxId)
    // Tapes in the deleted box fall back to Loose.
    const changed: Tape[] = []
    for (const tape of session.getTapes()) {
      if (tape.boxId === boxId) {
        const updated = { ...tape, boxId: null }
        session.upsertTape(updated)
        changed.push(updated)
      }
    }
    emit('boxes:changed', session.getBoxes())
    if (changed.length > 0) emit('tapes:updatedMany', changed)
    log.info('archive: box deleted', { id: boxId, orphaned: changed.length })
  })

  handle('boxes:reorder', async ({ orderedIds }) => {
    const byId = new Map(session.getBoxes().map((g) => [g.id, g]))
    orderedIds.forEach((id, order) => {
      const g = byId.get(id)
      if (g && g.order !== order) session.upsertBox({ ...g, order })
    })
    emit('boxes:changed', session.getBoxes())
  })

  handle('boxes:place', async ({ tapeIds, boxId, beforeTapeId }) => {
    const moving = new Set(tapeIds)
    const all = session.getTapes()

    // The target box's current members, minus anything being moved, in order.
    const members = all
      .filter((i) => i.boxId === boxId && !moving.has(i.id))
      .sort((a, b) => a.boxOrder - b.boxOrder)

    // The moved tapes, kept in the caller's requested order.
    const movingTapes = tapeIds
      .map((id) => all.find((i) => i.id === id))
      .filter((i): i is Tape => i !== undefined)

    let insertAt = members.length
    if (beforeTapeId) {
      const idx = members.findIndex((i) => i.id === beforeTapeId)
      if (idx >= 0) insertAt = idx
    }

    const ordered = [...members.slice(0, insertAt), ...movingTapes, ...members.slice(insertAt)]
    const changed: Tape[] = []
    ordered.forEach((tape, order) => {
      if (tape.boxId !== boxId || tape.boxOrder !== order) {
        const updated = { ...tape, boxId, boxOrder: order }
        session.upsertTape(updated)
        changed.push(updated)
      }
    })
    if (changed.length > 0) emit('tapes:updatedMany', changed)
  })
}
