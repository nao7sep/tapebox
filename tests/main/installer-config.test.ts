import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("Windows installer configuration", () => {
  it("uses the assisted dual-scope NSIS contract", () => {
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: true,
    });
  });
});

// Third-party notices are written in the release licence pass from what the
// candidate ships (licensing-conventions); only the app's own licence ships now.
describe("packaged license texts", () => {
  it("ships the app license", () => {
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      { from: "LICENSE", to: "LICENSE.txt" },
    ]));
  });

  it("prepares Electron before every package-script builder invocation", () => {
    for (const script of Object.values(packageJson.scripts) as string[]) {
      if (script.includes("electron-builder")) {
        expect(script.indexOf("npm run prepare:electron")).toBeLessThan(
          script.indexOf("electron-builder"),
        );
      }
    }
  });
});
