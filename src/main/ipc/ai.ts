import { handle } from './handle'
import * as session from '@main/store/session'
import * as ai from '@main/services/ai-client'
import { slugifyAscii } from '@main/core/slug'

export function registerAiHandlers(): void {
  handle('ai:generateSlug', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)
    const raw = await ai.generateSlug({
      title: tape.title,
      uploader: tape.uploader,
    })
    return { slug: slugifyAscii(raw) }
  })
}
