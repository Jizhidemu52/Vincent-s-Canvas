import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Database } from "../src/db";
import type { ObjectStorage } from "../src/object-storage";
import { createAssetsRouter } from "../src/routes/assets";
import type { AuthenticatedRequest, SessionUser } from "../src/types";
import { imageResultVariantIds, isAuxiliaryImageResult, readImageResultMetadata, resolveImageResultVariants, type ImageResultAsset } from "../src/image-result-variants";

const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003"];
const asset = (index: number, extra: Partial<ImageResultAsset> = {}): ImageResultAsset => ({ id: ids[index]!, ownerUserId: "employee-a", taskId: "task-a", mimeType: "image/png", filename: `image-${index}.png`, status: "ready", deletedAt: null, ...extra });
const reference = (index: number) => ({ assetId: ids[index]!, mimeType: "image/png", filename: `image-${index}.png` });
const metadata = () => ({ imageResult: { version: 1, role: "primary", resultIndex: 0, original: reference(1), export: reference(2), maskComposited: true, requestedOutputFormat: "webp", outputCompression: 83, warning: "导出副本不保证蒙版外像素不变", operations: ["mask-composite"] } });

describe("stored image variants", () => {
  test("unprocessed images expose their own original without invented lineage", () => {
    expect(resolveImageResultVariants(asset(0), [])).toEqual({ primary: { ...reference(0), url: `/api/assets/${ids[0]}/content` }, original: { ...reference(0), url: `/api/assets/${ids[0]}/content` }, maskComposited: false });
    expect(imageResultVariantIds(asset(0))).toEqual([]);
  });

  test("variant responses whitelist trusted stored descriptors instead of metadata URLs or keys", () => {
    const primary = asset(0, { metadata: metadata() });
    const original = { ...asset(1), object_key: "secret/path" };
    const exported = asset(2, { mimeType: "image/webp", filename: "export.webp" });
    const result = resolveImageResultVariants(primary, [original, exported]);
    expect(result.export).toEqual({ assetId: ids[2], url: `/api/assets/${ids[2]}/content`, mimeType: "image/webp", filename: "export.webp" });
    expect(result.maskComposited).toBe(true);
    expect(result.warning).toContain("像素");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(imageResultVariantIds(primary)).toEqual([ids[1]!, ids[2]!]);
  });

  test("malformed image metadata cannot silently invent a usable original", () => {
    for (const value of [null, [], {}, { ...metadata().imageResult, original: { ...reference(1), assetId: "../../other" } }, { ...metadata().imageResult, version: 2 }, { ...metadata().imageResult, outputCompression: 101 }]) {
      expect(() => readImageResultMetadata({ imageResult: value })).toThrow();
    }
    expect(readImageResultMetadata({ title: "ordinary upload" })).toBeNull();
  });

  test("missing, foreign, deleted, unready and unbound variants are rejected", () => {
    const primary = asset(0, { metadata: metadata() });
    for (const replacement of [null, asset(1, { ownerUserId: "employee-b" }), asset(1, { taskId: "task-b" }), asset(1, { taskId: null }), asset(1, { status: "pending" }), asset(1, { deletedAt: "2026-10-14" })]) {
      expect(() => resolveImageResultVariants(primary, [...(replacement ? [replacement] : []), asset(2)])).toThrow();
    }
    expect(() => resolveImageResultVariants({ ...primary, taskId: null }, [asset(1, { taskId: null }), asset(2, { taskId: null })])).toThrow();
  });

  test("only explicit v1 auxiliary roles are hidden from the normal list", () => {
    expect(isAuxiliaryImageResult(metadata())).toBe(false);
    expect(isAuxiliaryImageResult({})).toBe(false);
    expect(isAuxiliaryImageResult({ imageResult: { version: 1, role: "export" } })).toBe(true);
    expect(isAuxiliaryImageResult({ imageResult: { version: 1, role: "provider-original" } })).toBe(true);
    expect(isAuxiliaryImageResult({ imageResult: { version: 2, role: "export" } })).toBe(false);
  });
});

test("variants HTTP enforces current employee access and relation boundaries without exposing storage keys", async () => {
  let original = asset(1);
  let relationReads = 0;
  const primary = asset(0, { metadata: metadata() });
  const db = { query: async (sql: string, values: unknown[]) => {
    if (sql.includes("a.id=ANY")) {
      relationReads++;
      expect(sql).toContain("a.owner_user_id=$2");
      expect(sql).toContain("a.task_id=$3");
      expect(sql).toContain("a.status='ready'");
      expect(sql).toContain("a.deleted_at IS NULL");
      expect(sql).toContain("a.owner_user_id=$4");
      expect(values).toEqual([[ids[1], ids[2]], "employee-a", "task-a", "employee-a", null]);
      return { rows: [original, asset(2)] };
    }
    expect(sql).toContain("a.owner_user_id=$2");
    expect(sql).toContain("a.status='ready'");
    expect(sql).toContain("a.deleted_at IS NULL");
    return { rows: values[0] === ids[0] && values[1] === "employee-a" ? [primary] : [] };
  } } as unknown as Database;
  const app = express();
  app.use((request, _response, next) => { (request as AuthenticatedRequest).auth = { id: request.get("test-actor") || "employee-a", role: "designer", departmentId: null, groupId: null, groupRole: null } as SessionUser; next(); });
  app.use("/api/assets", createAssetsRouter(db, {} as ObjectStorage));
  const server = app.listen(0, "127.0.0.1");
  if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets/${ids[0]}/variants`;
    const denied = await fetch(url, { headers: { "test-actor": "employee-b" } });
    expect(denied.status).toBe(404);
    expect(relationReads).toBe(0);
    const allowed = await fetch(url);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("private, no-store");
    expect((await allowed.json()).original.assetId).toBe(ids[1]);
    original = asset(1, { ownerUserId: "employee-b" });
    const malformed = await fetch(url);
    expect(malformed.status).toBe(409);
    expect((await malformed.json()).error).toBe("IMAGE_RESULT_VARIANTS_INVALID");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
