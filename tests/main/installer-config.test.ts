import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("package scripts", () => {
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
