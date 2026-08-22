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
  it.runIf(process.platform !== 'win32')(
    'escalates from SIGTERM and terminates the owned POSIX process group',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tapebox-spawn-posix-tree-'))
      dirs.push(dir)
      const sentinel = join(dir, 'descendant-survived')
      const descendant =
        `process.on('SIGTERM', () => {}); ` +
        `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive'); process.exit(0) }, 3000)`
      const parent =
        // Mutation target: the direct parent exits on SIGTERM while its descendant
        // ignores it. Resolving on parent close would leave the descendant alive.
        `process.once('SIGTERM', () => process.exit(0)); ` +
        `const descendant = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); ` +
        `process.stdout.write('ready:' + descendant.pid + '\\n'); setInterval(() => {}, 1000)`
      const controller = new AbortController()
      const child = spawnStreaming(process.execPath, ['-e', parent], { signal: controller.signal })
      const exited = waitForExit(child, { command: 'POSIX tree fixture' })

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('fixture did not become ready')), 10_000)
        child.stdout.on('data', (chunk: Buffer) => {
          if (!chunk.toString().includes('ready:')) return
          clearTimeout(timeout)
          resolve()
        })
      })
      const started = Date.now()
      controller.abort()
      await expect(exited).rejects.toHaveProperty('name', 'AbortError')
      expect(Date.now() - started).toBeLessThan(4_000)
      await new Promise((resolve) => setTimeout(resolve, 3_500))
      await expect(access(sentinel)).rejects.toThrow()
    },
    15_000,
  )

  it.runIf(process.platform === 'win32')(
    'terminates descendants before the parent reports cancellation',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tapebox-spawn-tree-'))
      dirs.push(dir)
      const sentinel = join(dir, 'descendant-survived')
      const descendant =
        `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive'); process.exit(0) }, 4000)`
      const parent =
        `const descendant = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); ` +
        `process.stdout.write('ready:' + descendant.pid + '\\n'); setInterval(() => {}, 1000)`
      const controller = new AbortController()
      const child = spawnStreaming(process.execPath, ['-e', parent], { signal: controller.signal })
      const exited = waitForExit(child, { command: 'tree fixture' })

      const descendantPid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('fixture did not become ready')), 20_000)
        let output = ''
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          const match = /ready:(\d+)/.exec(output)
          if (!match) return
          clearTimeout(timeout)
          resolve(Number(match[1]))
        })
      })
      controller.abort()
      await expect(exited).rejects.toHaveProperty('name', 'AbortError')
      // Cancellation settlement is the disk-safety boundary used by queue.cancel:
      // the descendant must already be gone, not merely scheduled for taskkill.
      expect(() => process.kill(descendantPid, 0)).toThrow()
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      await expect(access(sentinel)).rejects.toThrow()
    },
    30_000,
  )
})
