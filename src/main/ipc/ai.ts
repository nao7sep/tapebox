import { tapeFile } from '@main/paths'
import { handle } from './handle'
import * as session from '@main/store/session'
import * as ai from '@main/services/ai-client'
import { readSidecarFile } from '@main/core/sidecar'
import { slugifyAscii } from '@main/core/slug'
import { getCollectionDir } from '@main/store/config'
import { cancelWork, runCancellable } from '@main/work-registry'
import type { Tape } from '@shared/domain'

export function registerAiHandlers(): void {
  // The renderer names each suggestion with its own requestId so Stop, or closing
  // the Rename/Export dialog, can abort that exact request (and its retry wait).
  handle('ai:generateSlug', async ({ tapeId, include, requestId }) => {
    const tape = session.getTape(tapeId)
    if (!tape) throw new Error(`Tape not found: ${tapeId}`)
    // Only the fields the user chose are sent; the description (the only one not
    // already on the tape) is read from the sidecar solely when included.
    const raw = await runCancellable(async (signal) => ai.generateSlug({
      tapeId,
      title: include.title ? tape.title : null,
      uploader: include.uploader ? tape.uploader : null,
      description: include.description ? await readDescription(tape) : null,
    }, signal), aiRequestKey(requestId))
    return { slug: slugifyAscii(raw) }
  })

  handle('ai:cancelSlug', async ({ requestId }) => {
    cancelWork(aiRequestKey(requestId))
  })
}

function aiRequestKey(requestId: string): string {
  return `ai:${requestId}`
}

/**
 * The source description, pulled from the sidecar's yt-dlp info.json (it isn't
 * kept on the Tape — descriptions are large and would bloat tape.json). Only
 * downloaded tapes have a sidecar. An absent optional field yields null; a
 * failed read must stop the request before selected input reaches the provider.
 */
async function readDescription(tape: Tape): Promise<string | null> {
  if (!tape.sidecarFilename) return null
  const data = await readSidecarFile(tapeFile(getCollectionDir(), tape, tape.sidecarFilename))
  const description = data.ytDlp['description']
  return typeof description === 'string' ? description : null
}
