import { join } from 'node:path'
import { handle } from './handle'
import * as session from '@main/store/session'
import * as ai from '@main/services/ai-client'
import { readSidecar } from '@main/core/sidecar'
import { slugifyAscii } from '@main/core/slug'
import { getSettings } from '@main/store/config'
import type { Tape } from '@shared/domain'

export function registerAiHandlers(): void {
  handle('ai:generateSlug', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)
    const raw = await ai.generateSlug({
      title: tape.title,
      uploader: tape.uploader,
      description: await readDescription(tape),
    })
    return { slug: slugifyAscii(raw) }
  })
}

/**
 * The source description, pulled from the sidecar's yt-dlp info.json (it isn't
 * kept on the Tape — descriptions are large and would bloat session.json). Only
 * downloaded tapes have a sidecar; best-effort, so a missing field or file just
 * yields null and the {description} token substitutes to empty.
 */
async function readDescription(tape: Tape): Promise<string | null> {
  if (!tape.sidecarFilename) return null
  const data = await readSidecar(join(getSettings().libraryDir, tape.sidecarFilename))
  const description = data?.['description']
  return typeof description === 'string' ? description : null
}
