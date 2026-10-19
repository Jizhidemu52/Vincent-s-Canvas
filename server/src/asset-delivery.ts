import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { create as contentDisposition } from "content-disposition";
import { fileTypeFromBuffer } from "file-type";
import type { Request, Response } from "express";
import type { ObjectStorage } from "./object-storage";

export const allowedAssetMimeTypes = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif",
  "video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4",
  "application/pdf", "text/plain", "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export const normalizeAssetMime = (value: string) => value.toLowerCase().split(";")[0]!.trim();
export class AssetMediaError extends Error { readonly status = 415; readonly code = "UNSUPPORTED_MEDIA_TYPE"; }

export async function validateAssetUpload(bytes: Uint8Array, declared: string) {
  const mime = normalizeAssetMime(declared);
  if (!allowedAssetMimeTypes.has(mime)) throw new AssetMediaError("不支持的文件类型");
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  if (detected) {
    if (!allowedAssetMimeTypes.has(detected.mime)) throw new AssetMediaError("文件真实类型不在允许范围内");
    return detected.mime;
  }
  if (mime !== "text/plain" && mime !== "application/json") throw new AssetMediaError("文件字节与声明的媒体类型不符");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new AssetMediaError("文本文件必须使用 UTF-8 编码"); }
  if (text.includes("\0") || /^\s*(?:<!doctype\s+html|<html\b|<svg\b|<script\b|<\?xml\b)/i.test(text)) {
    throw new AssetMediaError("不允许上传可执行网页或 SVG 内容");
  }
  if (mime === "application/json") {
    try { JSON.parse(text); } catch { throw new AssetMediaError("JSON 文件内容无效"); }
  }
  return mime;
}

export function assetResponseHeaders(mimeType: string, filename: string, download = false) {
  const mime = normalizeAssetMime(mimeType);
  const inline = allowedAssetMimeTypes.has(mime) && /^(image\/|video\/|audio\/|application\/pdf$)/.test(mime);
  return {
    "content-type": allowedAssetMimeTypes.has(mime) ? mime : "application/octet-stream",
    "content-disposition": contentDisposition(filename.replace(/[\x00-\x1f\x7f/\\]/g, "_"), { type: inline && !download ? "inline" : "attachment" }),
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-cache",
  };
}

export function matchesAssetEtag(header: string | undefined, etag: string | undefined) {
  if (!header || !etag) return false;
  const normal = (value: string) => value.trim().replace(/^W\//, "");
  return header.split(",").some(value => value.trim() === "*" || normal(value) === normal(etag));
}

/** Sniff a bounded prefix and replay it; original media is never buffered in full. */
export async function inspectAssetStream(body: Readable, declared: string) {
  const iterator = body[Symbol.asyncIterator]();
  const prefix: Buffer[] = [];
  let size = 0;
  try {
    while (size < 8192) {
      const part = await iterator.next();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      prefix.push(chunk); size += chunk.length;
    }
    const detected = await fileTypeFromBuffer(Buffer.concat(prefix, size).subarray(0, 8192)).catch(() => undefined);
    // Unknown/active content is attachment-only even for legacy records claiming image/*.
    const mimeType = detected && allowedAssetMimeTypes.has(detected.mime) ? detected.mime
      : ["text/plain", "application/json"].includes(declared) ? declared : "application/octet-stream";
    const stream = Readable.from((async function* () {
      try {
        for (const chunk of prefix) yield chunk;
        while (true) { const part = await iterator.next(); if (part.done) break; yield part.value; }
      } finally { await iterator.return?.(); }
    })());
    return { stream, mimeType };
  } catch (error) { body.destroy(); throw error; }
}

/** Call only AFTER current-employee authorization, including conditional requests. */
export async function streamAssetContent(request: Request, response: Response, storage: ObjectStorage,
  asset: { object_key: string; mime_type: string; filename: string }) {
  const objectInfo = await storage.head(asset.object_key);
  response.set(assetResponseHeaders(asset.mime_type, asset.filename, request.query.download === "1"));
  response.vary("Cookie");
  if (objectInfo.ETag) response.setHeader("ETag", objectInfo.ETag);
  if (matchesAssetEtag(request.get("if-none-match"), objectInfo.ETag)) { response.status(304).end(); return; }
  const object = await storage.get(asset.object_key);
  if (!object.Body) throw new Error("素材对象没有内容流");
  const body = object.Body as Readable;
  const cancel = () => body.destroy();
  response.on("close", cancel);
  try {
    const inspected = await inspectAssetStream(body, asset.mime_type);
    response.set(assetResponseHeaders(inspected.mimeType, asset.filename, request.query.download === "1"));
    if (object.ETag) response.setHeader("ETag", object.ETag);
    if (object.ContentLength !== undefined) response.setHeader("Content-Length", String(object.ContentLength));
    await pipeline(inspected.stream, response);
  } finally { response.off("close", cancel); body.destroy(); }
}
