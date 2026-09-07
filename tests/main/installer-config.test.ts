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

describe("packaged license texts", () => {
  it("ships the app, Electron, and Chromium licenses", () => {
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      { from: "LICENSE", to: "LICENSE.txt" },
      { from: "node_modules/electron/dist/LICENSE", to: "electron/LICENSE" },
      {
        from: "node_modules/electron/dist/LICENSES.chromium.html",
        to: "electron/LICENSES.chromium.html",
      },
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
