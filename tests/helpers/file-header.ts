import { FORMAT_OWNER, FORMATS } from '@main/io/file-header'

/** A file's header as TapeBox writes it, for fixtures (file-identity-conventions). */
export function header(name: keyof typeof FORMATS, version: number = FORMATS[name].version) {
  return {
    format: { owner: FORMAT_OWNER, kind: FORMATS[name].kind, version },
    writer: { name: 'tapebox', version: __APP_VERSION__ },
  }
}

/** A sidecar as TapeBox writes it: yt-dlp's fields under `ytDlp`, beside the
 *  `tapebox` section. */
export function sidecarFixture(
  ytDlp: Record<string, unknown> = {},
  tapebox: Record<string, unknown> = { media: null },
  version?: number,
) {
  return { ...header('sidecar', version), ytDlp, tapebox }
}
