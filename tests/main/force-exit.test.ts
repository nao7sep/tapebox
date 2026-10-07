import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('forces the process to end while a real worker remains blocked in native file open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tapebox-forced-exit-'))
  const fifo = join(root, 'held.pipe')
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    execFileSync('mkfifo', [fifo], { timeout: 1_000 })
    const helper = new URL('../../src/main/force-exit.ts', import.meta.url).href
    const script = `const {Worker}=require('node:worker_threads'); const worker=new Worker(\`const fs=require('node:fs'); const {workerData,parentPort}=require('node:worker_threads'); parentPort.postMessage('enter'); fs.openSync(workerData,'r');\`,{eval:true,workerData:process.argv[1]}); worker.once('message',()=>setTimeout(async()=>{process.stdout.write('forcing exit\\n'); const {forceExitProcess}=await import(${JSON.stringify(helper)}); forceExitProcess()},50));`
    child = spawn(process.execPath, ['-e', script, fifo], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout?.on('data', (value: Buffer) => { output += value.toString() })
    child.stderr?.on('data', (value: Buffer) => { output += value.toString() })
    closed = new Promise((resolve) => child!.once('close', (code, signal) => resolve({ code, signal })))
    const outcome = await Promise.race([closed, new Promise<'expired'>((resolve) => { timer = setTimeout(() => resolve('expired'), 2_000) })])
    expect(outcome).toEqual({ code: null, signal: 'SIGKILL' })
    expect(output).toBe('forcing exit\n')
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    await rm(root, { recursive: true, force: true })
  }
})
