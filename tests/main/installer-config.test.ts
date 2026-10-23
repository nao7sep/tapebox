import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

function assertPrepared(script: string): void {
  const preparation = script.indexOf('npm run prepare:electron')
  const builder = script.indexOf('electron-builder')
  expect(preparation).toBeGreaterThanOrEqual(0)
  expect(builder).toBeGreaterThanOrEqual(0)
  expect(preparation).toBeLessThan(builder)
}

describe('package scripts', () => {
  it('prepares Electron before every package-script builder invocation', () => {
    for (const script of Object.values(packageJson.scripts) as string[]) {
      if (script.includes('electron-builder')) assertPrepared(script)
    }
  })
  it.each([
    'npm run build && electron-builder --publish never',
    'electron-builder && npm run prepare:electron',
    'npm run prepare:electron',
  ])('rejects missing or misplaced preparation/build tokens: %s', (script) => {
    expect(() => assertPrepared(script)).toThrow()
  })
})

// The release attaches exactly the installers and portables the build names.
describe("release attachments", () => {
  it("lists one file glob for each artifact the build produces", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    const attached = [...workflow.matchAll(/^\s+(dist\/\S+)$/gm)].map((match) => match[1]);
    const named = (pattern: string, ext: string) => `dist/${pattern
      .replace("${productName}", packageJson.build.productName)
      .replace("${version}", "*")
      .replace("${ext}", ext)}`;
    const { mac, win, nsis } = packageJson.build;
    const expected = [
      ...mac.target.map((target: { target: string }) => named(mac.artifactName, target.target)),
      named(nsis.artifactName, "exe"),
      ...win.target.filter((target: string) => target !== "nsis").map((target: string) => named(win.artifactName, target)),
    ];
    expect(new Set(attached)).toEqual(new Set(expected));
  });
});

const { requiredRuntimeEntries, assertRequiredPackageEntries } = await import(
  new URL('../../scripts/package-entries.mjs', import.meta.url).href
) as { requiredRuntimeEntries: string[]; assertRequiredPackageEntries: (entries: string[], dependencies: Record<string, string>) => void }

describe('package runtime entries', () => {
  const complete = ['package.json', ...requiredRuntimeEntries, 'node_modules/example/package.json']
  it('accepts the complete runtime and dependencies', () => {
    expect(() => assertRequiredPackageEntries(complete, { example: '1' })).not.toThrow()
  })
  it.each(requiredRuntimeEntries)('rejects an archive missing %s', (missing) => {
    expect(() => assertRequiredPackageEntries(complete.filter((entry) => entry !== missing), { example: '1' })).toThrow(missing)
  })
})
