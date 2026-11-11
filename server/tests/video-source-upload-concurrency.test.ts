import { expect, test } from "bun:test";
import { prepareVideoProviderSources, preflightVideoSources } from "../src/video-source-preparation";

const source = (id: number) => ({ mimeType: "image/png", bytes: new Uint8Array([id]), width: 768, height: 768, publicUrl: `http://owned.example/api/provider-images/${id}` });
const input = { model: "doubao-seedance-2.5" as const, prompt: "fixture reference", parameters: { videoMode: "reference" }, baseUrl: "https://provider.invalid/v1", apiKey: "fixture-only" };

test("video references retain their order and owned URLs without making upload requests", async () => {
  const sources = [1, 2, 3, 4, 5].map(source);
  let requests = 0;
  const prepared = await prepareVideoProviderSources({ ...input, sources }, { fetch: async () => { requests++; throw new Error("must not upload"); } });
  expect(prepared.map(item => item.publicUrl)).toEqual(sources.map(item => item.publicUrl));
  expect(prepared.map(item => item.bytes)).toEqual(sources.map(item => item.bytes));
  expect(requests).toBe(0);
});

test.each([undefined, "asset://pending-owned-media", "data:image/png;base64,AQ==", "blob:https://owned.example/x", "http://minio:9000/x", "https://10.0.0.1/x"])("unusable final video reference URL is rejected without uploading (%s)", async publicUrl => {
  let requests = 0;
  await expect(prepareVideoProviderSources({ ...input, sources: [source(1), { ...source(2), publicUrl }] }, { fetch: async () => { requests++; return Response.json({}); } })).rejects.toThrow("公开 HTTP(S)");
  expect(requests).toBe(0);
});

test("owned placeholders are admission-only and invalid source properties still fail before I/O", async () => {
  expect(preflightVideoSources(input.model, input.prompt, input.parameters, [{ ...source(1), publicUrl: "asset://pending-owned-media" }]).normalized.referenceCount).toBe(1);
  let requests = 0;
  await expect(prepareVideoProviderSources({ ...input, sources: [source(1), { ...source(2), mimeType: "image/svg+xml" }] }, { fetch: async () => { requests++; return Response.json({}); } })).rejects.toThrow();
  expect(requests).toBe(0);
});
