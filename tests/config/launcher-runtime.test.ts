import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The launcher helper is plain ESM because both shell families execute it directly.
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { ownsProcess, REPO_ROOT } from "../../scripts/launcher-runtime.mjs";

describe("launcher process identity", () => {
  it("owns only this repository's TapeBox runtime", () => {
    expect(ownsProcess({
      pid: 10,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
      commandLine: "",
    })).toBe(true);
    expect(ownsProcess({
      pid: 11,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/dist/mac-arm64/TapeBox.app/Contents/MacOS/TapeBox`,
      commandLine: "",
    })).toBe(true);
    expect(ownsProcess({
      pid: 12,
      parentPid: 1,
      executablePath: `${REPO_ROOT}\\dist\\win-unpacked\\TapeBox.exe`,
      commandLine: "",
    })).toBe(true);
    expect(ownsProcess({
      pid: 13,
      parentPid: 1,
      executablePath: "/another/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      commandLine: "",
    })).toBe(false);
  });

  it("does not let a stale launcher generation clean up its replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "tapebox-launcher-test-"));
    const helper = join(root, "scripts", "launcher-runtime.mjs");
    try {
      await mkdir(join(root, "scripts"));
      await copyFile(join(REPO_ROOT, "scripts", "launcher-runtime.mjs"), helper);
      // The helper derives ownership from its checkout. Run an actual copy in a
      // disposable checkout so claims can never replace a live launcher's token.
      await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { pathToFileURL } from 'node:url';
        const { claimRuntime, isRuntimeOwner, releaseRuntime } = await import(pathToFileURL(process.argv[1]).href);
        try {
          await claimRuntime('first');
          await claimRuntime('second');
          assert.equal(await isRuntimeOwner('first'), false);
          assert.equal(await isRuntimeOwner('second'), true);
          assert.equal(await releaseRuntime('first'), false);
          assert.equal(await isRuntimeOwner('second'), true);
        } finally {
          await releaseRuntime('second');
        }
      `, helper]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
