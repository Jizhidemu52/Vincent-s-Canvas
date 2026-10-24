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

const sniffBytes = 8192;
async function assetMimeFromPrefix(prefix: Uint8Array, declared: string) {
  const detected = await fileTypeFromBuffer(prefix).catch(() => undefined);
  // Unknown/active content is attachment-only even for legacy records claiming image/*.
  return detected && allowedAssetMimeTypes.has(detected.mime) ? detected.mime
    : ["text/plain", "application/json"].includes(declared) ? declared : "application/octet-stream";
}

/** Sniff a bounded prefix and replay it; original media is never buffered in full. */
export async function inspectAssetStream(body: Readable, declared: string) {
  const iterator = body[Symbol.asyncIterator]();
  const prefix: Buffer[] = [];
  let size = 0;
  try {
    while (size < sniffBytes) {
      const part = await iterator.next();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      prefix.push(chunk); size += chunk.length;
    }
    const mimeType = await assetMimeFromPrefix(Buffer.concat(prefix, size).subarray(0, sniffBytes), declared);
    const stream = Readable.from((async function* () {
      try {
        for (const chunk of prefix) yield chunk;
        while (true) { const part = await iterator.next(); if (part.done) break; yield part.value; }
      } finally { await iterator.return?.(); }
    })());
    return { stream, mimeType };
  } catch (error) { body.destroy(); throw error; }
}

function matchesIfRange(value: string | undefined, etag?: string, modified?: Date) {
  if (!value) return true;
  // If-Range requires a strong, exact ETag match, unlike If-None-Match.
  if (value.includes('"')) return value.startsWith('"') && value === etag;
  // Ready asset objects are write-once; compare Last-Modified at HTTP date precision.
  return Boolean(modified && Date.parse(value) === Math.floor(modified.getTime() / 1000) * 1000);
}

function assetRange(request: Request, size: number, etag?: string, modified?: Date) {
  const header = request.get("range");
  // S3 does not implement multipart ranges. Ignore those and unknown units.
  if (request.method !== "GET" || !header || !/^bytes=/i.test(header) || header.includes(",")
    || !matchesIfRange(request.get("if-range"), etag, modified)) return undefined;
  const parsed = request.range(size); // Express uses the existing range-parser dependency.
  if (parsed === -1) {
    // range-parser 1.x rejects a suffix longer than the object; HTTP defines it as the whole object.
    const suffix = /^bytes=\s*-(\d+)\s*$/i.exec(header);
    if (size > 0 && suffix && Number(suffix[1]) > size) return { start: 0, end: size - 1 };
    return -1;
  }
  return parsed && parsed !== -2 && parsed.length === 1 ? parsed[0] : undefined;
}

/** Call only AFTER current-employee authorization, including conditional requests. */
export async function streamAssetContent(request: Request, response: Response, storage: ObjectStorage,
  asset: { object_key: string; mime_type: string; filename: string }) {
  const controller = new AbortController();
  let body: Readable | undefined;
  const cancel = () => { if (!response.writableFinished) controller.abort(); body?.destroy(); };
  response.on("close", cancel);
  request.on("aborted", cancel);
  try {
    if (response.destroyed || request.aborted) cancel();
    controller.signal.throwIfAborted();
    const objectInfo = await storage.head(asset.object_key, { abortSignal: controller.signal });
    controller.signal.throwIfAborted();
    response.set(assetResponseHeaders(asset.mime_type, asset.filename, request.query.download === "1"));
    response.vary("Cookie");
    if (objectInfo.ETag) response.setHeader("ETag", objectInfo.ETag);
    if (objectInfo.LastModified) response.setHeader("Last-Modified", objectInfo.LastModified.toUTCString());
    const size = Number.isSafeInteger(objectInfo.ContentLength) && objectInfo.ContentLength! >= 0 ? objectInfo.ContentLength : undefined;
    if (size !== undefined) response.setHeader("Accept-Ranges", "bytes");
    if (matchesAssetEtag(request.get("if-none-match"), objectInfo.ETag)) { response.status(304).end(); return; }
    const range = size === undefined ? undefined : assetRange(request, size, objectInfo.ETag, objectInfo.LastModified);
    if (range === -1) { response.status(416).setHeader("Content-Range", `bytes */${size}`); response.end(); return; }

    const read = async (part?: { start: number; end: number }) => {
      controller.signal.throwIfAborted();
      const object = await storage.get(asset.object_key, {
        range: part ? `bytes=${part.start}-${part.end}` : undefined,
        ifMatch: objectInfo.ETag, abortSignal: controller.signal,
      });
      if (!object.Body) throw new Error("素材对象没有内容流");
      body = object.Body as Readable;
      controller.signal.throwIfAborted();
      if (part && (object.ContentRange !== `bytes ${part.start}-${part.end}/${size}`
        || object.ContentLength !== part.end - part.start + 1)) throw new Error("对象存储未返回请求的素材分段");
      return { object, stream: body };
    };

    let mimeType: string | undefined;
    // Short opening ranges (e.g. Safari's bytes=0-1) also need a complete sniff prefix.
    if (request.method === "HEAD" || (range && (range.start > 0 || range.end < Math.min(size!, sniffBytes) - 1))) {
      if (size === undefined) throw new Error("素材对象没有有效长度");
      if (size === 0) mimeType = await assetMimeFromPrefix(Buffer.alloc(0), asset.mime_type);
      else {
        const prefix = await read({ start: 0, end: Math.min(size, sniffBytes) - 1 });
        const inspected = await inspectAssetStream(prefix.stream, asset.mime_type);
        mimeType = inspected.mimeType;
        inspected.stream.destroy(); prefix.stream.destroy(); body = undefined;
      }
    }
    if (request.method === "HEAD") {
      response.set(assetResponseHeaders(mimeType!, asset.filename, request.query.download === "1"));
      response.setHeader("Content-Length", String(size)); response.end(); return;
    }
    const { object, stream } = await read(range);
    const inspected = mimeType ? { stream, mimeType } : await inspectAssetStream(stream, asset.mime_type);
    response.set(assetResponseHeaders(inspected.mimeType, asset.filename, request.query.download === "1"));
    if (object.ETag) response.setHeader("ETag", object.ETag);
    if (object.ContentLength !== undefined) response.setHeader("Content-Length", String(object.ContentLength));
    if (range) { response.status(206); response.setHeader("Content-Range", object.ContentRange!); }
    await pipeline(inspected.stream, response, { signal: controller.signal });
  } finally { response.off("close", cancel); request.off("aborted", cancel); body?.destroy(); controller.abort(); }
}
