import { join } from 'node:path'
import { handle } from './handle'
import * as session from '@main/store/session'
import * as ai from '@main/services/ai-client'
import { readSidecar } from '@main/core/sidecar'
import { slugifyAscii } from '@main/core/slug'
import { getLibraryDir } from '@main/store/config'
import type { Tape } from '@shared/domain'

export function registerAiHandlers(): void {
  handle('ai:generateSlug', async ({ tapeId, include }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)
    // Only the fields the user chose are sent; the description (the only one not
    // already on the tape) is read from the sidecar solely when included.
    const raw = await ai.generateSlug({
      title: include.title ? tape.title : null,
      uploader: include.uploader ? tape.uploader : null,
      description: include.description ? await readDescription(tape) : null,
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
  const data = await readSidecar(join(getLibraryDir(), tape.sidecarFilename))
  const description = data?.['description']
  return typeof description === 'string' ? description : null
}
