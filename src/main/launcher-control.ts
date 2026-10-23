import { createServer } from 'node:http'
import { rename, unlink, writeFile } from 'node:fs/promises'

/** Only a launcher-spawned instance exposes ordinary Quit. The private token
 * identifies this launch even if a PID or loopback port is later reused. */
export async function startLauncherControl(quit: () => void, env = process.env): Promise<(() => Promise<void>) | undefined> {
  const path = env['TAPEBOX_LAUNCHER_READY']
  const token = env['TAPEBOX_LAUNCHER_TOKEN']
  if (!path || !token) return undefined
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return }
    if (request.method !== 'POST' || request.url !== '/quit') { response.writeHead(404).end(); return }
    response.writeHead(202).end()
    setImmediate(quit)
  })
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Launcher control has no TCP address')
  const stage = `${path}.tmp`
  try {
    await writeFile(stage, JSON.stringify({ token, pid: process.pid, port: address.port }), { mode: 0o600 })
    await rename(stage, path)
  } catch (error) {
    await close()
    await unlink(stage).catch((cleanup) => { if (cleanup.code !== 'ENOENT') throw cleanup })
    throw error
  }
  return close
}
