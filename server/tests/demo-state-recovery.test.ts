import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readDemoRecovery } from "../src/demo-state-recovery";

const asset = {
  id: "10000000-0000-4000-8000-000000000001", ownerUserId: "owner", filename: "original.png", mimeType: "image/png",
  createdAt: "2026-09-11T01:02:03.000Z", base64: "AQID", byteSize: 3,
  sha256: createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"),
  metadata: { title: "原素材", tags: ["保留"], note: "不可改写" },
};
const task = {
  id: "20000000-0000-4000-8000-000000000001", requestId: "original-request", ownerUserId: "owner", status: "success",
  createdAt: "2026-09-11T01:02:02.000Z", resultUrls: [`/api/assets/${asset.id}/content`],
  credits: 3, prompt: "原提示词", parameters: { size: "16:9" },
};

test("restores original bytes and every supplied field without mutating the snapshot", () => {
  const snapshot = { assets: [asset], tasks: [task] };
  const original = JSON.stringify(snapshot);
  const result = readDemoRecovery(snapshot);
  const { base64: _base64, ...fields } = asset;
  expect(result.assets).toEqual([{ ...fields, bytes: new Uint8Array([1, 2, 3]) }]);
  expect(result.tasks).toEqual([task]);
  expect(JSON.stringify(snapshot)).toBe(original);
  expect(readDemoRecovery({ assets: [], tasks: [] })).toEqual({ assets: [], tasks: [] });
});

test("requires object records and assets/tasks arrays, instead of silently importing an empty collection", () => {
  for (const invalid of [null, [], "snapshot", {}, { assets: [] }, { tasks: [] }, { assets: null, tasks: [] }, { assets: {}, tasks: [] }, { assets: [], tasks: "invalid" }]) {
    expect(() => readDemoRecovery(invalid)).toThrow();
  }
  for (const invalid of [null, [], "record", 123]) {
    expect(() => readDemoRecovery({ assets: [invalid], tasks: [] })).toThrow();
    expect(() => readDemoRecovery({ assets: [], tasks: [invalid] })).toThrow();
  }
});

test("rejects duplicate asset IDs, task IDs and request IDs before an import can overwrite records", () => {
  expect(() => readDemoRecovery({ assets: [asset, { ...asset, base64: "BAUG" }], tasks: [] })).toThrow("重复的素材 ID");
  expect(() => readDemoRecovery({ assets: [], tasks: [task, { ...task, requestId: "different-request" }] })).toThrow("重复的任务 ID");
  expect(() => readDemoRecovery({ assets: [], tasks: [task, { ...task, id: "different-task" }] })).toThrow("重复的任务 requestId");
  for (const invalid of ["", "  ", null, 123]) {
    expect(() => readDemoRecovery({ assets: [{ ...asset, id: invalid }], tasks: [] })).toThrow("非空字符串");
    expect(() => readDemoRecovery({ assets: [], tasks: [{ ...task, id: invalid }] })).toThrow("非空字符串");
    expect(() => readDemoRecovery({ assets: [], tasks: [{ ...task, requestId: invalid }] })).toThrow("非空字符串");
  }
});

test("requires valid asset owner, filename, MIME type and ISO creation time", () => {
  for (const patch of [{ ownerUserId: " " }, { filename: "" }, { filename: 123 }, { mimeType: "not-a-mime" }, { mimeType: null }, { createdAt: "yesterday" }, { createdAt: "2026-02-30T00:00:00Z" }, { createdAt: 123 }]) {
    expect(() => readDemoRecovery({ assets: [{ ...asset, ...patch }], tasks: [] })).toThrow("无效");
  }
  expect(readDemoRecovery({ assets: [{ ...asset, mimeType: "text/plain; charset=utf-8", createdAt: "2026-09-11T09:02:03+08:00" }], tasks: [] }).assets).toHaveLength(1);
});

test("requires task identity, allowed status, creation time and a string-array resultUrls", () => {
  for (const patch of [{ ownerUserId: " " }, { status: "queued" }, { status: null }, { createdAt: "invalid" }, { createdAt: "2026-02-30T00:00:00Z" }, { resultUrls: null }, { resultUrls: "https://example.test/image.png" }, { resultUrls: [123] }]) {
    expect(() => readDemoRecovery({ assets: [], tasks: [{ ...task, ...patch }] })).toThrow("无效");
  }
  expect(() => readDemoRecovery({ assets: [], tasks: [{ ...task, status: "processing" }] })).toThrow("执行中的任务");
  for (const status of ["success", "failed", "paused"]) expect(readDemoRecovery({ assets: [], tasks: [{ ...task, status, resultUrls: [] }] }).tasks[0]?.status).toBe(status);
});

test("rejects empty or noncanonical base64 and mismatched byteSize without fixing them", () => {
  expect(() => readDemoRecovery({ assets: [{ ...asset, base64: "" }], tasks: [] })).toThrow("空素材");
  for (const base64 of ["AQID\n", " AQID", "AQID!", "AQI", "AQJ=", "AQID====", "@@@", null, 123]) {
    expect(() => readDemoRecovery({ assets: [{ ...asset, base64 }], tasks: [] })).toThrow();
  }
  for (const byteSize of [0, 4, "3", null, 3.5, Number.NaN]) {
    expect(() => readDemoRecovery({ assets: [{ ...asset, byteSize }], tasks: [] })).toThrow("byteSize");
  }
  const { byteSize: _byteSize, sha256: _sha256, ...withoutOptionalIntegrity } = asset;
  expect(readDemoRecovery({ assets: [withoutOptionalIntegrity], tasks: [] }).assets[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
});

test("verifies sha256, preserves supplied hash casing and rejects corrupted bytes or malformed hashes", () => {
  const uppercase = asset.sha256.toUpperCase();
  expect(readDemoRecovery({ assets: [{ ...asset, sha256: uppercase }], tasks: [] }).assets[0]?.sha256).toBe(uppercase);
  expect(() => readDemoRecovery({ assets: [{ ...asset, base64: "BAUG" }], tasks: [] })).toThrow("SHA-256");
  for (const sha256 of ["0".repeat(64), "bad hash", "", null, 123]) {
    expect(() => readDemoRecovery({ assets: [{ ...asset, sha256 }], tasks: [] })).toThrow("SHA-256");
  }
});
