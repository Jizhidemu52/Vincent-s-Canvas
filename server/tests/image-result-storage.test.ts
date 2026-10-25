import { describe, expect, test } from "bun:test";
import { storeImageResult, hasImageResultProcessing, ImageResultPersistenceError } from "../src/image-result-storage";
import { isAuxiliaryImageResult, resolveImageResultVariants, type ImageResultAsset } from "../src/image-result-variants";

const result = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "image/png" };
function harness() {
  const assets: Array<ImageResultAsset & { bytes: Uint8Array }> = [];
  const calls: string[] = [];
  return {
    assets, calls,
    save: async (role: string, image: { bytes: Uint8Array; mimeType: string }, metadata: Record<string, unknown>) => {
      calls.push(`save:${role}`);
      const asset = { id: crypto.randomUUID(), ownerUserId: "owner", taskId: "task", filename: `${role}.${image.mimeType.split("/")[1]}`, ...image, metadata };
      assets.push(asset);
      return { assetId: asset.id, mimeType: asset.mimeType, filename: asset.filename };
    },
    updateMetadata: async (asset: { assetId: string }, metadata: Record<string, unknown>) => {
      calls.push("metadata");
      assets.find(item => item.id === asset.assetId)!.metadata = metadata;
    },
  };
}

describe("durable image variants without paid replay", () => {
  test("unrequested result is one original asset with no decode or copy", async () => {
    const h = harness();
    const primary = await storeImageResult({ ...h, result, parameters: {}, resultIndex: 0,
      process: async () => { throw new Error("must not decode"); } });
    expect(h.calls).toEqual(["save:primary"]);
    expect(h.assets[0]!.bytes).toBe(result.bytes);
    expect(primary.assetId).toBe(h.assets[0]!.id);
  });

  test("transparency-only validation archives opaque provider bytes and exposes a recoverable processing failure", async () => {
    const h = harness();
    const opaque = { mimeType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC", "base64") };
    const before = Buffer.from(opaque.bytes);
    expect(hasImageResultProcessing({ background: "transparent" })).toBe(true);
    expect(hasImageResultProcessing({ background: "opaque" })).toBe(false);
    const error = await storeImageResult({ ...h, result: opaque, parameters: { background: "transparent" }, resultIndex: 0 }).catch(error => error);
    expect(error).toBeInstanceOf(ImageResultPersistenceError);
    expect(error.cause).toMatchObject({ code: "IMAGE_RESULT_TRANSPARENCY_MISSING" });
    expect(error.message).toContain("渠道原件已保存");
    expect(error.message).toContain("透明");
    expect(error.message).toContain("不会自动重新生成");
    expect(h.calls).toEqual(["save:provider-original"]);
    expect(h.assets).toHaveLength(1);
    expect(h.assets[0]!.bytes).toBe(opaque.bytes);
    expect(h.assets[0]!.bytes).toEqual(before);
    expect(error.original.assetId).toBe(h.assets[0]!.id);
    expect(isAuxiliaryImageResult(h.assets[0]!.metadata)).toBe(false);
  });

  test("persists original before preparation, stores one primary, and hides auxiliary variants", async () => {
    const h = harness();
    const primary = await storeImageResult({ ...h, result, parameters: { output_format: "webp", output_compression: "80", inputArchive: { maskReferenceIndex: 1 } }, resultIndex: 2,
      prepareEditInput: async () => { expect(h.assets[0]!.bytes).toBe(result.bytes); h.calls.push("prepare"); return { references: [result], mask: result }; },
      process: async () => { h.calls.push("process"); return { display: { ...result, bytes: new Uint8Array([9]) }, export: { bytes: new Uint8Array([8]), mimeType: "image/webp" }, operations: ["strict_mask_composite", "format_conversion"] }; },
    });
    expect(h.calls).toEqual(["save:provider-original", "prepare", "process", "save:export", "save:primary", "metadata"]);
    expect(h.assets[0]!.bytes).toBe(result.bytes);
    const visible = h.assets.filter(asset => !isAuxiliaryImageResult(asset.metadata));
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe(primary.assetId);
    expect(resolveImageResultVariants(visible[0]!, h.assets)).toMatchObject({ primary: { assetId: primary.assetId }, original: { assetId: h.assets[0]!.id }, export: { mimeType: "image/webp" }, maskComposited: true });
  });

  for (const phase of ["prepare", "process"] as const) {
    test(`${phase} failure leaves original visible and emits a local-processing error`, async () => {
      const h = harness();
      const error = await storeImageResult({ ...h, result, parameters: { output_format: "jpeg" }, resultIndex: 0,
        prepareEditInput: async () => { if (phase === "prepare") throw new Error("source unavailable"); return { references: [] }; },
        process: async () => { throw new Error("encoder unavailable"); },
      }).catch(error => error);
      expect(error).toBeInstanceOf(ImageResultPersistenceError);
      expect(error.message).toContain("渠道原件已保存");
      expect(h.assets).toHaveLength(1);
      expect(h.assets[0]!.bytes).toBe(result.bytes);
      expect(isAuxiliaryImageResult(h.assets[0]!.metadata)).toBe(false);
    });
  }

  test("optional export storage failure still returns strict primary with visible warning", async () => {
    const h = harness();
    const primary = await storeImageResult({ ...h, save: async (role, image, metadata) => {
      if (role === "export") throw new Error("export disk quota");
      return h.save(role, image, metadata);
    }, result, parameters: { output_format: "jpeg" }, resultIndex: 0,
    process: async () => ({ display: { ...result, bytes: new Uint8Array([9]) }, export: { bytes: new Uint8Array([8]), mimeType: "image/jpeg" }, operations: ["strict_mask_composite"] }) });
    const variants = resolveImageResultVariants(h.assets.find(asset => asset.id === primary.assetId)!, h.assets);
    expect(variants.maskComposited).toBe(true);
    expect(variants.export).toBeUndefined();
    expect(variants.warning).toContain("副本保存失败");
  });

  test("unchanged true-format original is not duplicated", async () => {
    const h = harness();
    const primary = await storeImageResult({ ...h, result, parameters: { output_format: "png" }, resultIndex: 0,
      process: async () => ({ display: result, operations: [] }) });
    expect(h.assets).toHaveLength(1);
    expect(h.assets[0]!.id).toBe(primary.assetId);
    expect(isAuxiliaryImageResult(h.assets[0]!.metadata)).toBe(false);
    expect(resolveImageResultVariants(h.assets[0]!, [])).toMatchObject({ original: { assetId: primary.assetId } });
  });
});
