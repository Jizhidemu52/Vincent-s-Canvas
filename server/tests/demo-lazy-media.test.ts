import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { demoAssetContentResponse, canRestoreDemoAsset } from "../src/demo-asset-library";
import { DemoStateStore, DemoStorageError, demoAssetByteLength, demoAssetFields, materializeDemoAsset } from "../src/demo-state-store";

type Asset = { id: string; bytes: Uint8Array; byteSize: number; filename: string; mimeType: string; metadata: { title: string }; deletedAt?: string };
const asset = (id: string, bytes = new Uint8Array([0, 255, 1, 2])): Asset => ({ id, bytes, byteSize: 9000, filename: `${id}.bin`, mimeType: "application/octet-stream", metadata: { title: id } });

test("loading and updating many asset records never selects or rewrites original BLOBs", () => {
  const store = new DemoStateStore<Asset>(":memory:");
  try {
    store.save({ assets: Array.from({ length: 25 }, (_, i) => asset(`asset-${i}`, new Uint8Array(256 * 1024).fill(i))) });
    store.save({ assets: [asset("pending", new Uint8Array())] });
    const db = Reflect.get(store, "db") as Database;
    const query = spyOn(db, "query");
    const reads = spyOn(store, "readAssetBytes");
    try {
      const state = store.load();
      expect(state.assets).toHaveLength(26);
      expect(state.assets.map(demoAssetByteLength)).toEqual([...Array(25).fill(256 * 1024), 0]);
      expect(demoAssetByteLength(state.assets[25]!)).not.toBe(state.assets[25]!.byteSize);
      const metadata = state.assets.map(item => ({ ...demoAssetFields(item), deletedAt: new Date().toISOString() }));
      expect(JSON.stringify(metadata)).not.toContain('"bytes"');
      store.saveAssetMetadata(metadata);
      const refreshed = store.getAsset("asset-0")!;
      expect(canRestoreDemoAsset(refreshed)).toBe(true);
      expect(canRestoreDemoAsset(store.getAsset("pending")!)).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      for (const [sql] of query.mock.calls) {
        if (/select[\s\S]*from\s+demo_assets/i.test(sql)) {
          expect(sql.replace(/length\(bytes\)/gi, "stored_length")).not.toMatch(/\bbytes\b|select\s+\*/i);
        }
        if (/update\s+demo_assets/i.test(sql)) expect(sql).not.toMatch(/\bbytes\b/i);
      }
    } finally { reads.mockRestore(); query.mockRestore(); }
  } finally { store.close(); }
});

test("explicit materialization reads only one original and metadata writes preserve its exact bytes", () => {
  const store = new DemoStateStore<Asset>(":memory:");
  try {
    const original = asset("original");
    store.save({ assets: [original, asset("unrelated")] });
    const reads = spyOn(store, "readAssetBytes");
    try {
      const loaded = store.getAsset(original.id)!;
      const material = materializeDemoAsset(loaded);
      expect(reads.mock.calls).toEqual([[original.id]]);
      expect(material.bytes).toEqual(original.bytes);
      expect(material.bytes).toBe(loaded.bytes);
      store.saveAssetMetadata([{ ...demoAssetFields(loaded), metadata: { title: "changed" } }]);
      expect(reads).toHaveBeenCalledTimes(1);
      // A fresh handle must work from SQLite even when no earlier WeakRef is available.
      expect(store.getAsset(original.id)!.bytes).toEqual(original.bytes);
      expect(reads).toHaveBeenCalledTimes(2);
      expect(store.getAsset(original.id)!.metadata.title).toBe("changed");
      expect(() => store.saveAssetMetadata([
        { ...demoAssetFields(loaded), metadata: { title: "must rollback" } },
        { ...demoAssetFields(loaded), id: "missing" },
      ])).toThrow(DemoStorageError);
      expect(store.getAsset(original.id)!.metadata.title).toBe("changed");
      expect(() => store.saveAssetMetadata([original])).toThrow("不能包含原件内容");
    } finally { reads.mockRestore(); }
  } finally { store.close(); }
});

test("metadata extraction skips an enumerable bytes getter without evaluating it", () => {
  const value = { id: "never-read", metadata: { title: "safe" }, get bytes(): Uint8Array { throw new Error("unexpected original read"); } };
  expect(demoAssetFields(value)).toEqual({ id: "never-read", metadata: { title: "safe" } });
});

test("content responses read once, respect byte offsets, and answer a matching ETag without an original read", async () => {
  let reads = 0;
  const raw = new Uint8Array([99, 0, 255, 1, 2, 88]);
  const value = { ...demoAssetFields(asset("response")), get bytes() { reads++; return raw.subarray(1, 5); } };
  const response = await demoAssetContentResponse(value, new Request("http://localhost/api/assets/response/content?download=1"));
  expect(reads).toBe(1);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 2]));
  expect(response.headers.get("content-disposition")).toContain("attachment");
  const cached = await demoAssetContentResponse(value, new Request("http://localhost/api/assets/response/content", { headers: { "if-none-match": response.headers.get("etag")! } }));
  expect(cached.status).toBe(304);
  expect(await cached.text()).toBe("");
  expect(reads).toBe(1);
  expect(new Uint8Array(await (await demoAssetContentResponse(value)).arrayBuffer())).toEqual(new Uint8Array([0, 255, 1, 2]));
  expect(reads).toBe(2);
});
