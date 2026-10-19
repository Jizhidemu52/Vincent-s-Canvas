import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { validateAssetUpload, assetResponseHeaders, matchesAssetEtag, inspectAssetStream } from "../src/asset-delivery";
import { parseAssetListQuery, assetPage, assetBatchSchema } from "../src/asset-query";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
test("upload MIME is verified from bytes and active markup cannot masquerade as an image", async () => {
  expect(await validateAssetUpload(png, "image/jpeg")).toBe("image/png");
  await expect(validateAssetUpload(Buffer.from('<html><script>alert(1)</script></html>'), "image/png")).rejects.toThrow();
  await expect(validateAssetUpload(Buffer.from('<svg onload="alert(1)"/>'), "image/svg+xml")).rejects.toThrow();
  expect(await validateAssetUpload(Buffer.from('正常文字'), "text/plain")).toBe("text/plain");
  await expect(validateAssetUpload(Buffer.from('{invalid'), "application/json")).rejects.toThrow();
});
test("response headers force unknown types to download and encode untrusted filenames", () => {
  const headers = assetResponseHeaders('text/html', '恶意\r\nX-Injected: yes.html');
  expect(headers['content-disposition']).toStartWith("attachment;");
  expect(headers['content-disposition']).not.toContain('\r');
  expect(headers['content-disposition']).not.toContain('\n');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(assetResponseHeaders('image/png', '图片.png')['content-disposition']).toStartWith('inline;');
});
test("ETag revalidation supports lists and weak validators", () => {
  expect(matchesAssetEtag('"other", W/"match"', '"match"')).toBe(true);
  expect(matchesAssetEtag('*', '"match"')).toBe(true);
  expect(matchesAssetEtag('"other"', '"match"')).toBe(false);
});
test("sniffing a chunked stream preserves every original byte", async () => {
  const input = Readable.from([png.subarray(0, 2), png.subarray(2, 20), png.subarray(20)]);
  const result = await inspectAssetStream(input, "image/jpeg");
  expect(result.mimeType).toBe("image/png");
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(png);
});
test("stable cursor pages preserve tied timestamps and reject malformed cursors", () => {
  const ids=['00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001'];
  const rows=ids.map(id=>({ id, createdAt:'2026-10-19T00:00:00.000Z' }));
  const first=assetPage(rows,2);
  expect(first.assets.map(v=>v.id)).toEqual(ids.slice(0,2));
  expect(first.hasMore).toBe(true);
  expect(parseAssetListQuery({cursor:first.nextCursor!,limit:'2'}).cursor?.id).toBe(ids[1]);
  expect(parseAssetListQuery({}).limit).toBe(60);
  expect(()=>parseAssetListQuery({limit:'201'})).toThrow();
  expect(()=>parseAssetListQuery({cursor:'garbage'})).toThrow();
});
test("batch operations reject over 50 or repeated asset IDs before any mutation", () => {
  const id='00000000-0000-4000-8000-000000000001';
  expect(assetBatchSchema.safeParse({ action:'delete',assetIds:[id] }).success).toBe(true);
  expect(assetBatchSchema.safeParse({ action:'delete',assetIds:[id,id] }).success).toBe(false);
  expect(assetBatchSchema.safeParse({ action:'delete',assetIds:Array(51).fill(id) }).success).toBe(false);
  expect(assetBatchSchema.safeParse({ action:'move-project',assetIds:[id] }).success).toBe(false);
});
