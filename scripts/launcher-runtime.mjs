// Repository-owned launch transaction. Usage: launch <token> <executable> [args],
// launch-dev <token> <host> <port>, publish-launch <token> <candidate> <relative-exe>,
// stop-if-owner <token>, wait-owner <token>, or check-endpoint <host> <port>.
// Ownership is a captured PID/creation identity plus a private app control token;
// executable paths and occupied ports never authorize closing another instance.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_FILE = join(tmpdir(), `company-launcher-${createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 20)}.json`);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function processIdentity(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`], { timeout: 10000 });
    return stdout.trim() || null;
  }
  try {
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000 });
    return stdout.trim() || null;
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim()) return null;
    throw error;
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function runtimeOwner({ recordPath = OWNER_FILE, identity = processIdentity, wait = delay,
  now = Date.now, close = async (record) => {
    const response = await fetch(`http://127.0.0.1:${record.app.port}/quit`, {
      method: 'POST', headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`The app refused the close request (${response.status}).`);
  }, timeout = 10000 } = {}) {
  const lockPath = `${recordPath}.lock`;
  const read = () => readJson(recordPath);
  const save = async (record) => {
    const stage = `${recordPath}.tmp`;
    await writeFile(stage, JSON.stringify(record), { mode: 0o600 });
    await rename(stage, recordPath);
  };
  const alive = async (process) => process?.created && await identity(process.pid) === process.created;
  async function locked(work) {
    let lock;
    const deadline = now() + timeout;
    for (;;) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (now() >= deadline) throw new Error(`Another launcher is still working. Wait for it to finish. If it crashed, close its terminal and remove ${lockPath}, then retry.`);
        await wait(100);
      }
    }
    try { return await work(); }
    finally { await lock.close(); await unlink(lockPath); }
  }
  async function stop(record) {
    if (!record) return;
    const requested = new Set();
    const deadline = now() + timeout;
    for (;;) {
      // electron-vite can replace its Electron child on a main-process edit.
      // Its inherited private token registers the new child of this generation.
      const ready = record.readyPath ? await readJson(record.readyPath) : null;
      if (ready?.token === record.token && (ready.pid !== record.app?.pid || ready.port !== record.app?.port)) {
        const created = await identity(ready.pid);
        if (created) {
          record.app = { pid: ready.pid, created, port: ready.port };
          record.launching = false;
          await save(record);
        }
      }
      const appAlive = await alive(record.app);
      const key = record.app && `${record.app.pid}:${record.app.created}:${record.app.port}`;
      if (appAlive && !requested.has(key)) { await close(record); requested.add(key); }
      if (!await alive(record.root) && !await alive(record.app)) {
        if (record.launching) throw new Error(`A previous launch never registered readiness. Close its app and terminal, then remove ${recordPath} and retry.`);
        if (record.readyPath) await unlink(record.readyPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        return;
      }
      if (now() >= deadline) throw new Error('TapeBox is still running. Finish or cancel its close question, or close its launcher terminal, then retry. Nothing was force-closed.');
      await wait(100);
    }
  }
  return {
    read, save, alive,
    replace: (token, launch) => locked(async () => {
      await stop(await read());
      const record = { token, root: null, app: null };
      await save(record);
      // Keep the transaction locked through readiness: no later invocation can
      // claim this generation between closure, launch and registration.
      return await launch(record, save);
    }),
    stopIfOwner: (token) => locked(async () => {
      const record = await read();
      if (record?.token !== token) return false;
      await stop(record);
      await unlink(recordPath);
      return true;
    }),
  };
}

async function launch(token, executable, args, prepare = async () => undefined) {
  if (!/^[a-zA-Z0-9-]+$/.test(token)) throw new Error('Invalid launcher token.');
  const owner = runtimeOwner();
  await owner.replace(token, async (record, save) => {
    const cleanup = await prepare();
    const readyPath = `${OWNER_FILE}.${token}.ready`;
    record.readyPath = readyPath;
    record.launching = true;
    await save(record);
    const child = spawn(executable, args, {
      cwd: REPO_ROOT, detached: true, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, TAPEBOX_LAUNCHER_READY: readyPath, TAPEBOX_LAUNCHER_TOKEN: token },
    });
    try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
    catch (error) { record.launching = false; await save(record); throw error; }
    child.unref();
    record.root = { pid: child.pid, created: await processIdentity(child.pid) };
    await save(record);
    {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const ready = await readJson(readyPath);
        if (ready?.token === token) {
          const created = await processIdentity(ready.pid);
          if (!created) throw new Error('TapeBox exited before becoming ready.');
          record.app = { pid: ready.pid, created, port: ready.port };
          record.launching = false;
          await save(record);
          await cleanup?.();
          process.stdout.write('TapeBox is ready.\n');
          return;
        }
        if (!record.root.created || !await owner.alive(record.root)) throw new Error('The launched app exited before becoming ready. An independently launched TapeBox may have been activated; close it and retry.');
        await delay(100);
      }
      throw new Error('TapeBox did not become ready. Check its terminal output, close it, then retry.');
    }
  });
}

/** Keep the last runnable package until its validated replacement is published. */
export async function publishCandidate(candidate, destination, token, move = rename) {
  const previous = `${destination}.previous-${token}`;
  let retained = false;
  try { await move(destination, previous); retained = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await move(candidate, destination); }
  catch (error) {
    if (retained) {
      try { await move(previous, destination); }
      catch (restore) { throw new AggregateError([error, restore], `Package publication failed; the previous package remains at ${previous}.`); }
    }
    throw error;
  }
  return async () => { if (retained) await rm(previous, { recursive: true }); };
}

async function assertEndpointAvailable(host, port) {
  await new Promise((resolveProbe, rejectProbe) => {
    const probe = createServer();
    probe.once('error', (error) => rejectProbe(new Error(`Cannot bind ${host}:${port}: ${error.code ?? error.message}. The listener was left running because its ownership is unknown.`)));
    probe.listen({ host, port, exclusive: true }, () => probe.close((error) => error ? rejectProbe(error) : resolveProbe()));
  });
}

async function main([command, ...args]) {
  const owner = runtimeOwner();
  if (command === 'launch-dev' && args[0] && args[1] && Number.isInteger(Number(args[2]))) {
    return launch(args[0], process.execPath, [join(REPO_ROOT, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev'],
      async () => { await assertEndpointAvailable(args[1], Number(args[2])); });
  }
  if (command === 'publish-launch' && args[0] && args[1] && args[2]) {
    const candidate = resolve(args[1]);
    const destination = join(REPO_ROOT, 'dist');
    const executable = resolve(destination, args[2]);
    if (candidate !== `${destination}.candidate-${args[0]}` || !executable.startsWith(destination + sep)) throw new Error('Invalid candidate package path.');
    return launch(args[0], executable, [], () => publishCandidate(candidate, destination, args[0]));
  }
  if (command === 'launch' && args[0] && args[1]) return launch(args[0], args[1], args.slice(2));
  if (command === 'stop-if-owner' && args[0]) return owner.stopIfOwner(args[0]);
  if (command === 'wait-owner' && args[0]) {
    for (;;) {
      const record = await owner.read();
      if (record?.token !== args[0] || (!await owner.alive(record.root) && !await owner.alive(record.app))) return;
      await delay(250);
    }
  }
  if (command === 'check-endpoint' && args[0] && Number.isInteger(Number(args[1]))) return assertEndpointAvailable(args[0], Number(args[1]));
  throw new Error('Expected launch <token> <executable> [args], stop-if-owner <token>, wait-owner <token>, or check-endpoint <host> <port>.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
