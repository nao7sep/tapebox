import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { log } from '@main/io/logger'
import { boxNameError, uniqueBoxName } from '@shared/archive-names'
import type { ArchiveGroup, Item } from '@shared/domain'

/**
 * Organization of archived tapes into boxes. A box is a named, ordered list; a
 * tape belongs to one box (Item.groupId) or to Ungrouped. Box membership and
 * within-box order live on the items; the box list itself is in the session.
 */
export function registerArchiveHandlers(): void {
  handle('archive:listGroups', async () => session.getGroups())

  handle('archive:createGroup', async ({ name }) => {
    const groups = session.getGroups()
    const order = groups.reduce((max, g) => Math.max(max, g.order), -1) + 1
    // Seed with a unique, non-reserved name so the inline edit that follows
    // always starts from a valid name the user can overtype.
    const finalName = uniqueBoxName(name.trim() || 'New box', groups.map((g) => g.name))
    const group: ArchiveGroup = { id: nanoid(10), name: finalName, order }
    session.upsertGroup(group)
    emit('groups:changed', session.getGroups())
    log.info('archive: box created', { id: group.id, name: group.name })
    return group
  })

  handle('archive:renameGroup', async ({ groupId, name }) => {
    const groups = session.getGroups()
    const group = groups.find((g) => g.id === groupId)
    if (!group) throw new Error(`Box not found: ${groupId}`)
    const trimmed = name.trim()
    if (!trimmed) return group // empty = no-op, keep the current name
    // Authoritative guard; the renderer validates inline, but main is the
    // source of truth (reserved words + case-insensitive uniqueness).
    const err = boxNameError(trimmed, groups.filter((g) => g.id !== groupId).map((g) => g.name))
    if (err) throw new Error(err)
    const updated = { ...group, name: trimmed }
    session.upsertGroup(updated)
    emit('groups:changed', session.getGroups())
    return updated
  })

  handle('archive:deleteGroup', async ({ groupId }) => {
    session.removeGroup(groupId)
    // Tapes in the deleted box fall back to Ungrouped.
    const changed: Item[] = []
    for (const item of session.getItems()) {
      if (item.groupId === groupId) {
        const updated = { ...item, groupId: null }
        session.upsertItem(updated)
        changed.push(updated)
      }
    }
    emit('groups:changed', session.getGroups())
    if (changed.length > 0) emit('items:updatedMany', changed)
    log.info('archive: box deleted', { id: groupId, orphaned: changed.length })
  })

  handle('archive:reorderGroups', async ({ orderedIds }) => {
    const byId = new Map(session.getGroups().map((g) => [g.id, g]))
    orderedIds.forEach((id, order) => {
      const g = byId.get(id)
      if (g && g.order !== order) session.upsertGroup({ ...g, order })
    })
    emit('groups:changed', session.getGroups())
  })

  handle('archive:placeItems', async ({ itemIds, groupId, beforeItemId }) => {
    const moving = new Set(itemIds)
    const all = session.getItems()

    // The target box's current members, minus anything being moved, in order.
    const members = all
      .filter((i) => i.groupId === groupId && !moving.has(i.id))
      .sort((a, b) => a.archiveOrder - b.archiveOrder)

    // The moved tapes, kept in the caller's requested order.
    const movingItems = itemIds
      .map((id) => all.find((i) => i.id === id))
      .filter((i): i is Item => i !== undefined)

    let insertAt = members.length
    if (beforeItemId) {
      const idx = members.findIndex((i) => i.id === beforeItemId)
      if (idx >= 0) insertAt = idx
    }

    const ordered = [...members.slice(0, insertAt), ...movingItems, ...members.slice(insertAt)]
    const changed: Item[] = []
    ordered.forEach((item, order) => {
      if (item.groupId !== groupId || item.archiveOrder !== order) {
        const updated = { ...item, groupId, archiveOrder: order }
        session.upsertItem(updated)
        changed.push(updated)
      }
    })
    if (changed.length > 0) emit('items:updatedMany', changed)
  })
}
