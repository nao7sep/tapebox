import { describe, expect, it } from "vitest";
import { LayoutSchema } from "@shared/layout";

const normalBounds = { x: 89, y: 81, width: 1201, height: 749 };
const windowsNormalBounds = { left: 111, top: 101, right: 1613, bottom: 1038 };

describe("native placement layout schema", () => {
  it("preserves native and logical geometry together", () => {
    const record = { normalBounds, windowsNormalBounds, mode: "maximized" };
    const parsed = LayoutSchema.parse({ windowPlacements: { main: record } });
    expect(parsed.windowPlacements.main).toEqual(record);
    expect(parsed.windowPlacements.main?.windowsNormalBounds).not.toBe(windowsNormalBounds);
  });
  it("discards only a malformed native field", () => {
    const record = { normalBounds, windowsNormalBounds: { ...windowsNormalBounds, left: 1.5 }, mode: "normal" };
    const parsed = LayoutSchema.parse({ volume: 0.5, windowPlacements: { main: record } });
    expect(parsed.volume).toBe(0.5);
    expect(parsed.windowPlacements.main).toEqual({ normalBounds, mode: "normal", windowsNormalBounds: null });
  });
  it("keeps an absent legacy field omitted", () => {
    const record = { normalBounds, mode: "normal" };
    const parsed = LayoutSchema.parse({ windowPlacements: { main: record } });
    expect(parsed.windowPlacements.main).toEqual(record);
    expect(Object.hasOwn(parsed.windowPlacements.main!, "windowsNormalBounds")).toBe(false);
  });
});
