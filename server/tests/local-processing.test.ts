import { expect, test } from "bun:test";
import { localProcessingInputSchema, type LocalProcessingInput } from "../../shared/local-processing-contracts";
import { assertLocalProcessingUploadInput } from "../src/local-processing";

const id = "71000000-0000-4000-8000-000000000001";
const input = { clientOperationId: id, assetId: id, board: "creative-pattern-colorway", operation: "recolor", prompt: "精确换色",
  sourceAssetIds: [id], parameters: { form: { description: "原始完整要求" }, recolor: { rules: [{ from: "#112233", to: "#445566" }], tolerance: 10 } } } satisfies LocalProcessingInput;

test("local processing accepts only the actual scene-operation pairs and complete parameters", () => {
  expect(localProcessingInputSchema.parse(input)).toEqual(input);
  const mixedCase = "71AAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  expect(localProcessingInputSchema.parse({ ...input, assetId: mixedCase, sourceAssetIds: [mixedCase], clientOperationId: mixedCase }))
    .toMatchObject({ assetId: mixedCase.toLowerCase(), sourceAssetIds: [mixedCase.toLowerCase()], clientOperationId: mixedCase.toLowerCase() });
  for (const changed of [
    { board: "creative-garment-colorway" }, { operation: "image_generation" }, { sourceTaskId: id },
    { parameters: {} }, { sourceAssetIds: [id, id] }, { prompt: "x".repeat(8001) },
    { parameters: { ...input.parameters, recolor: { rules: [], tolerance: 10 } } },
    { parameters: { ...input.parameters, recolor: { rules: input.parameters.recolor.rules, tolerance: 101 } } },
  ]) expect(localProcessingInputSchema.safeParse({ ...input, ...changed }).success).toBe(false);
});

test("local processing refuses credentials, local file pointers and oversized nested archives rather than truncating", () => {
  for (const config of [
    { apiKey: "private" }, { nested: { credentials: "private" } }, { imageOptions: { dataUrl: "data:image/png;base64,a" } },
    { storageKey: "local-image" }, { arbitrary: "blob:http://local/image" }, { many: Array(101).fill("a") },
    { fields: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`field${index}`, "字".repeat(2000)])) },
  ]) expect(localProcessingInputSchema.safeParse({ ...input, parameters: { ...input.parameters, config } }).success).toBe(false);
});

test("upload fields cannot create trusted local-processing provenance", () => {
  const upload = { filename: "result.png", mimeType: "image/png", byteSize: 100, kind: "image", metadata: {} };
  for (const changed of [
    { metadata: { localProcessing: { version: 1 } } }, { metadata: { localProcessingUpload: { version: 1 } } },
    { clientReferenceId: `local-processing:${id}` }, { clientReferenceId: `local-processing-upload:${id}` },
    { localProcessingOperationId: id }, { localProcessingOperationId: id, kind: "video", metadata: { contentSha256: "a".repeat(64) } },
  ]) expect(() => assertLocalProcessingUploadInput({ ...upload, ...changed })).toThrow();
  expect(() => assertLocalProcessingUploadInput({ ...upload, localProcessingOperationId: id, metadata: { contentSha256: "a".repeat(64) } })).not.toThrow();
});
