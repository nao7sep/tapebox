import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnStreaming, waitForExit } from '@main/io/spawn'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('owned subprocess cancellation', () => {
  it.runIf(process.platform === 'win32')(
    'terminates descendants before the parent reports cancellation',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tapebox-spawn-tree-'))
      dirs.push(dir)
      const sentinel = join(dir, 'descendant-survived')
      const descendant =
        `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive'); process.exit(0) }, 4000)`
      const parent =
        `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); ` +
        `process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`
      const controller = new AbortController()
      const child = spawnStreaming(process.execPath, ['-e', parent], { signal: controller.signal })
      const exited = waitForExit(child, { command: 'tree fixture' })

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('fixture did not become ready')), 20_000)
        child.stdout.on('data', (chunk: Buffer) => {
          if (!chunk.toString().includes('ready')) return
          clearTimeout(timeout)
          resolve()
        })
      })
      controller.abort()
      await expect(exited).rejects.toHaveProperty('name', 'AbortError')
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      await expect(access(sentinel)).rejects.toThrow()
    },
    30_000,
  )
})
