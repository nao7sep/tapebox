import { handle } from './handle'
import * as session from '@main/store/session'
import * as ai from '@main/services/ai-client'
import { slugifyAscii } from '@main/core/slug'

export function registerAiHandlers(): void {
  handle('ai:generateSlug', async ({ itemId }) => {
    const item = session.getItem(itemId)
    if (!item) throw new Error(`Item not found: ${itemId}`)
    const raw = await ai.generateSlug({
      title: item.originalTitle ?? item.title,
      uploader: item.uploader,
    })
    return { slug: slugifyAscii(raw) }
  })
}
