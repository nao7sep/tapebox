import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// tests/main/force-exit.test.ts proves the forced exit in plain Node. This runs
// the same primitive inside the real Electron runtime, whose main process tears
// down differently: a worker stays blocked in a native file open on a FIFO that
// no writer ever opens, and the forced exit must still end the process. It needs
// the installed Electron binary, so it runs in the full gate only.

const electronBinary = createRequire(import.meta.url)('electron') as unknown as string

it.skipIf(process.platform === 'win32')('ends Electron while a worker remains blocked in native file open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tapebox-forced-exit-electron-'))
  const fifo = join(root, 'held.pipe')
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    execFileSync('mkfifo', [fifo], { timeout: 1_000 })
    // The shipped primitive, read from source rather than restated here.
    const primitive = /export function forceExitProcess\(\): void \{([\s\S]*?)\n\}/.exec(
      await readFile(new URL('../../../src/main/force-exit.ts', import.meta.url), 'utf8'),
    )![1]!
    const main = join(root, 'main.cjs')
    await writeFile(main, [
      `const { app } = require('electron')`,
      `const { Worker } = require('node:worker_threads')`,
      `function forceExitProcess() {${primitive}}`,
      `app.whenReady().then(() => {`,
      `  const worker = new Worker(\`const fs = require('node:fs'); const { workerData, parentPort } = require('node:worker_threads'); parentPort.postMessage('enter'); fs.openSync(workerData, 'r')\`, { eval: true, workerData: ${JSON.stringify(fifo)} })`,
      `  worker.once('message', () => setTimeout(() => { process.stdout.write('forcing exit\\n'); forceExitProcess() }, 50))`,
      `})`,
    ].join('\n'))
    child = spawn(electronBinary, [main], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
    let output = ''
    child.stdout?.on('data', (value: Buffer) => { output += value.toString() })
    closed = new Promise((resolve) => child!.once('close', (code, signal) => resolve({ code, signal })))
    const outcome = await Promise.race([closed, new Promise<'expired'>((resolve) => { timer = setTimeout(() => resolve('expired'), 15_000) })])
    expect(outcome).toEqual({ code: null, signal: 'SIGKILL' })
    expect(output).toContain('forcing exit\n')
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    await rm(root, { recursive: true, force: true })
  }
})
