import { net, protocol } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getSettings } from '@main/store/config'

/**
 * Custom protocol that serves files from the library directory to the
 * renderer's <video>/<audio>/<img> elements. Path traversal is blocked by
 * normalizing the requested path and rejecting anything outside libraryDir.
 *
 * Renderer usage: tapebox-media:///filename.mp4
 *                            ▲▲
 *                            two slashes after the scheme, then the basename
 */

export const MEDIA_SCHEME = 'tapebox-media'

/**
 * Called once BEFORE app.whenReady() to register the scheme as privileged
 * (secure, streams, supports fetch and range requests). Must happen this
 * early or Chromium refuses to load media from the scheme.
 */
export function registerMediaSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ])
}

/**
 * Called after app is ready. Hooks the actual request handler.
 */
export function registerMediaProtocolHandler(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const requested = new URL(request.url)
    const filename = decodeURIComponent(requested.pathname).replace(/^\//, '')
    if (!filename) return new Response('not found', { status: 404 })

    const libDir = normalize(getSettings().libraryDir)
    const full = normalize(join(libDir, filename))

    const within = full === libDir || full.startsWith(libDir + sep)
    if (!within) return new Response('forbidden', { status: 403 })

    return net.fetch(pathToFileURL(full).toString())
  })
}
