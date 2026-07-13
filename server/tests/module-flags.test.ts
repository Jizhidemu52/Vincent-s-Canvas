import { describe, expect, test } from "bun:test";

import { assertModuleEnabled, isModuleEnabled, ModuleDisabledError, moduleForOperation, moduleKeys } from "../src/module-flags";
import type { Database } from "../src/db";

describe("module availability", () => {
  test("maps task operations to independently controlled modules", () => {
    expect(moduleKeys).toContain("performance");
    expect(moduleForOperation("image_generation")).toBe("image");
    expect(moduleForOperation("upscale")).toBe("detail-enhance");
    expect(moduleForOperation("inpaint")).toBe("image-edit");
    expect(moduleForOperation("inpaint", { tool: "angle-control" })).toBe("angle-control");
    expect(moduleForOperation("seamless_stitch")).toBe("seamless-stitch");
    expect(moduleForOperation("batch_image")).toBe("canvas");
    expect(moduleForOperation("unknown")).toBeNull();
  });

  test("blocks a disabled module with a stable business error", async () => {
    const db = { query: async () => ({ rows: [{ enabled: false }] }) } as unknown as Database;
    expect(await isModuleEnabled(db, "image")).toBe(false);
    await expect(assertModuleEnabled(db, "image")).rejects.toBeInstanceOf(ModuleDisabledError);
    await expect(assertModuleEnabled(db, null)).resolves.toBeUndefined();
  });

  test("treats missing module configuration as disabled", async () => {
    const db = { query: async () => ({ rows: [] }) } as unknown as Database;
    expect(await isModuleEnabled(db, "video")).toBe(false);
  });
});
