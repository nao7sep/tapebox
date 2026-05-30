/**
 * Release a <video> element's media so the underlying file is no longer in use
 * before any operation that renames or deletes it on disk. On Windows the OS
 * refuses rename/unlink/trash while the file's bytes are still being streamed;
 * dropping the src aborts the HTTP request to the loopback media server, which
 * closes its read stream. On macOS/Linux it isn't strictly required but keeps
 * behavior uniform.
 */
export function releaseVideo(el: HTMLVideoElement | null): void {
  if (!el) return
  el.pause()
  el.removeAttribute('src')
  el.load()
}
