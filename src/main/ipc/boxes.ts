import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { log } from '@main/io/logger'
import { boxNameError, uniqueBoxName } from '@shared/box-names'
import { frontOrders } from '@shared/order'
import type { Box, Tape } from '@shared/domain'

/**
 * Organization of archived tapes into boxes. A box is a named, ordered list; a
 * tape belongs to one box (Tape.boxId) or to Unboxed. Box membership and
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
    log.info('archive: box renamed', { id: box.id, from: box.name, to: trimmed })
    return updated
  })

  handle('boxes:delete', async ({ boxId }) => {
    session.removeBox(boxId)
    // The deleted box's tapes fall back to Unboxed, landing on top as a block in the
    // order they held inside the box — so their arrangement survives the delete
    // and their orders can't collide with whatever Unboxed already holds.
    const orphans = session
      .getTapes()
      .filter((t) => t.boxId === boxId)
      .sort((a, b) => a.order - b.order)
    const unboxed = session.getTapes().filter((t) => t.archivedAtUtc && t.boxId === null)
    const orders = frontOrders(unboxed.map((t) => t.order), orphans.length)
    const changed: Tape[] = []
    orphans.forEach((tape, i) => {
      const updated = { ...tape, boxId: null, order: orders[i] }
      session.upsertTape(updated)
      changed.push(updated)
    })
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
    log.info('archive: boxes reordered', { count: orderedIds.length })
  })

  handle('boxes:place', async ({ tapeIds, boxId }) => {
    const moving = new Set(tapeIds)
    const all = session.getTapes()

    // The destination list's current members (archived tapes filed there), minus
    // anything being moved. Unboxed is boxId === null, so the archived guard keeps
    // inbox tapes — which also have boxId null — out of it.
    const members = all
      .filter((i) => i.archivedAtUtc && i.boxId === boxId && !moving.has(i.id))
      .sort((a, b) => a.order - b.order)

    // The moved tapes, kept in the caller's requested order, placed on top — newly
    // filed tapes land at the front of their new box.
    const movingTapes = tapeIds
      .map((id) => all.find((i) => i.id === id))
      .filter((i): i is Tape => i !== undefined)

    const ordered = [...movingTapes, ...members]
    const changed: Tape[] = []
    ordered.forEach((tape, order) => {
      if (tape.boxId !== boxId || tape.order !== order) {
        const updated = { ...tape, boxId, order }
        session.upsertTape(updated)
        changed.push(updated)
      }
    })
    if (changed.length > 0) emit('tapes:updatedMany', changed)
  })
}
