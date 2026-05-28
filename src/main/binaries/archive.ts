import { createWriteStream } from 'node:fs'
import unzipper from 'unzipper'

/**
 * Extract a single named file from a zip into outPath.
 * Matches files by exact path or by basename (so binaries nested in
 * directories like 'ffmpeg-master/bin/ffmpeg.exe' are found by 'ffmpeg.exe').
 */
export async function extractFileFromZip(
  zipPath: string,
  innerName: string,
  outPath: string,
): Promise<void> {
  const directory = await unzipper.Open.file(zipPath)
  const file = directory.files.find(
    (f) => f.type === 'File' && (f.path === innerName || f.path.endsWith('/' + innerName)),
  )
  if (!file) {
    const available = directory.files.filter((f) => f.type === 'File').map((f) => f.path).join(', ')
    throw new Error(`File ${innerName} not found in archive. Available: ${available}`)
  }

  await new Promise<void>((resolve, reject) => {
    file
      .stream()
      .pipe(createWriteStream(outPath))
      .on('finish', () => resolve())
      .on('error', reject)
  })
}
