import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { validateAssetUpload, assetResponseHeaders, matchesAssetEtag, inspectAssetStream } from "../src/asset-delivery";
import { parseAssetListQuery, assetPage, assetBatchSchema } from "../src/asset-query";
import * as XLSX from "xlsx";
import { fileTypeFromBuffer } from "file-type";
import { createHash } from "node:crypto";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
test("upload MIME is verified from bytes and active markup cannot masquerade as an image", async () => {
  expect(await validateAssetUpload(png, "image/jpeg")).toBe("image/png");
  await expect(validateAssetUpload(Buffer.from('<html><script>alert(1)</script></html>'), "image/png")).rejects.toThrow();
  await expect(validateAssetUpload(Buffer.from('<svg onload="alert(1)"/>'), "image/svg+xml")).rejects.toThrow();
  expect(await validateAssetUpload(Buffer.from('正常文字'), "text/plain")).toBe("text/plain");
  await expect(validateAssetUpload(Buffer.from('{invalid'), "application/json")).rejects.toThrow();
});
test.each(["text/csv", "text/markdown"])("%s source files accept only UTF-8 safe text and remain downloads", async mime => {
  const original = Buffer.from(mime === "text/csv" ? '\ufeff款号,颜色\r\nA01,"红色,暖调"\r\n' : "# 设计要求\n红色开衫，保留五粒纽扣。\n");
  expect(await validateAssetUpload(original, `${mime}; charset=utf-8`)).toBe(mime);
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x41, 0]), Buffer.from("正常\0文字"), Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('<svg onload="alert(1)"/>'), Buffer.from('<script>alert(1)</script>')]) {
    await expect(validateAssetUpload(bytes, mime)).rejects.toThrow();
  }
  await expect(validateAssetUpload(png, mime)).rejects.toThrow();
  const headers = assetResponseHeaders(mime, mime === "text/csv" ? "原件.csv" : "原件.md");
  expect(headers["content-type"]).toBe(mime);
  expect(headers["content-disposition"]).toStartWith("attachment;");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  const inspected = await inspectAssetStream(Readable.from([original.subarray(0, 2), original.subarray(2)]), mime);
  expect(inspected.mimeType).toBe(mime);
  const received: Buffer[] = [];
  for await (const chunk of inspected.stream) received.push(Buffer.from(chunk));
  expect(Buffer.concat(received)).toEqual(original);
});
test.each(["biff5", "biff8"] as const)("real %s XLS uploads validate the workbook and preserve original bytes", async bookType => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Style", "Color"], ["A01", "Red"]]), "Design");
  const bytes = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType }));
  const hash = createHash("sha256").update(bytes).digest("hex");
  expect(await fileTypeFromBuffer(bytes)).toMatchObject({ mime: "application/x-cfb" });
  expect(await validateAssetUpload(bytes, "application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
  const inspected = await inspectAssetStream(Readable.from([bytes.subarray(0, 1024), bytes.subarray(1024)]), "application/vnd.ms-excel");
  expect(inspected.mimeType).toBe("application/vnd.ms-excel");
  const received: Buffer[] = [];
  for await (const chunk of inspected.stream) received.push(Buffer.from(chunk));
  expect(Buffer.concat(received)).toEqual(bytes);
  const headers = assetResponseHeaders(inspected.mimeType, "原始款式.xls");
  expect(headers["content-disposition"]).toStartWith("attachment;");
  expect(headers["x-content-type-options"]).toBe("nosniff");
});
test("XLS admission rejects arbitrary OLE, fake or nested Workbook streams, HTML, encryption and raw legacy BIFF", async () => {
  for (const name of ["WordDocument", "Workbook", "Book", "nested/Workbook", "EncryptedPackage"]) {
    const container = XLSX.CFB.utils.cfb_new({ root: "Root Entry" });
    XLSX.CFB.utils.cfb_add(container, name, Buffer.from('<html><script>alert(1)</script></html>'));
    const bytes = XLSX.CFB.write(container, { type: "buffer" });
    expect(await fileTypeFromBuffer(bytes)).toMatchObject({ mime: "application/x-cfb" });
    await expect(validateAssetUpload(bytes, "application/vnd.ms-excel")).rejects.toThrow("工作簿");
    await expect(validateAssetUpload(bytes, "application/x-cfb")).rejects.toThrow("不支持");
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["A"]]), "Sheet1");
  const raw = XLSX.write(workbook, { type: "buffer", bookType: "biff2" });
  for (const bytes of [png, raw, Buffer.from('<table><tr><td>A</td></tr></table>')]) await expect(validateAssetUpload(bytes, "application/vnd.ms-excel")).rejects.toThrow("格式不受支持");
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
