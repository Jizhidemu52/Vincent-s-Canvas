import { DOMParser } from "@xmldom/xmldom";
import { recraftTools, type RecraftAction } from "../../shared/recraft-tools";
import { fetchProviderSubmission } from "./provider-submission-transport";
import { readBoundedImage } from "./seedream55-reference";
import { inspectEditImage } from "./image-edit-input";
import { ProviderSubmissionRejected, isDefinitiveSubmissionRejection } from "./provider-submission-policy";

export async function validateRecraftSource(action: RecraftAction, source: { bytes: Uint8Array; mimeType: string }) {
  if (!source || !["image/png", "image/jpeg", "image/webp"].includes(source.mimeType) || source.bytes.length >= 20_000_000) throw new Error("请选择小于 20 MB 的 PNG、JPEG 或 WebP 原图");
  const { width, height } = await inspectEditImage(source, "original");
  const minimum = action === "hd-upscale" ? 32 : 256;
  if (Math.min(width, height) < minimum || Math.max(width, height) > 4096 || width * height > 16_000_000) throw new Error(`此工具要求每边 ${minimum}–4096 像素，最多 1600 万像素`);
}

export function assertRecraftVector(bytes: Buffer) {
  const xml = bytes.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(xml)) throw new Error("矢量结果包含不支持的 XML 内容");
  const doc = new DOMParser({ onError: () => { throw new Error("矢量结果 XML 无效"); } }).parseFromString(xml, "image/svg+xml");
  if (doc.documentElement?.tagName !== "svg" || doc.documentElement.namespaceURI !== "http://www.w3.org/2000/svg") throw new Error("服务未返回 SVG 矢量图");
  const tags = new Set(["svg","g","path","rect","ellipse","circle","polygon","polyline","line","defs","clipPath","mask","linearGradient","radialGradient","stop","title","desc"]);
  const attrs = new Set(["xmlns","xmlns:xlink","version","width","height","viewBox","preserveAspectRatio","x","y","x1","x2","y1","y2","cx","cy","r","rx","ry","d","points","id","transform","fill","fill-rule","fill-opacity","stroke","stroke-width","stroke-opacity","stroke-linejoin","stroke-linecap","stroke-miterlimit","opacity","clip-path","clip-rule","mask","gradientUnits","gradientTransform","offset","stop-color","stop-opacity","shape-rendering"]);
  for (const element of Array.from(doc.getElementsByTagName("*"))) {
    if (!tags.has(element.tagName) || element.namespaceURI !== doc.documentElement.namespaceURI) throw new Error("矢量结果包含不支持的元素");
    for (const attr of Array.from(element.attributes)) {
      if (element.tagName === "stop" && attr.name === "class" && /^[\w-]+(?:\s+[\w-]+)*$/.test(attr.value)) continue;
      if (attr.name === "style" && /^\s*display\s*:\s*block\s*;?\s*$/.test(attr.value)) continue;
      if (!attrs.has(attr.name) || (!attr.name.startsWith("xmlns") && /[\\]|\/\*|url\s*\((?!#[\w.-]+\))/i.test(attr.value))) throw new Error("矢量结果包含不支持的属性");
    }
  }
}

export type RecraftResult = { image_id: string; url: string };

export function isRecraftResult(value: unknown): value is RecraftResult {
  if (!value || typeof value !== "object" || !("image_id" in value) || typeof value.image_id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.image_id)) return false;
  if (!("url" in value) || typeof value.url !== "string" || value.url.length > 8192 || !URL.canParse(value.url)) return false;
  const url = new URL(value.url);
  return url.origin === "https://img.recraft.ai" && !url.username && !url.password;
}

export class RecraftOutputInvalid extends Error {}

export async function downloadRecraftResult(action: RecraftAction, image: RecraftResult) {
  if (!isRecraftResult(image)) throw new RecraftOutputInvalid("Recraft 原结果地址无效");
  let bytes: Buffer;
  try {
    const response = await fetch(image.url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("下载未完成");
    }
    bytes = await readBoundedImage(response.body, 256 * 1024 * 1024);
  } catch {
    throw Object.assign(new Error("Recraft 已完成处理，原结果下载未完成"), { code: "RESULT_DOWNLOAD_FAILED" });
  }
  if (action === "vectorize") {
    try { assertRecraftVector(bytes); }
    catch (error) { throw new RecraftOutputInvalid(error instanceof Error ? error.message : "矢量结果校验未通过"); }
    return { bytes, mimeType: "image/svg+xml" };
  }
  if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new RecraftOutputInvalid("Recraft 未返回 PNG 图像");
  return { bytes, mimeType: "image/png" };
}

export async function runRecraftImage(action: RecraftAction, source: { bytes: Uint8Array; mimeType: string }, beforeSubmit: () => Promise<void>, token = process.env.RECRAFT_API_TOKEN,
  saveReceipt?: (image: RecraftResult) => Promise<void>, submit = fetchProviderSubmission) {
  if (!token?.trim()) throw new Error("服务端尚未配置 Recraft API 密钥");
  await validateRecraftSource(action, source);
  const body = new FormData();
  body.set("file", new Blob([Buffer.from(source.bytes)], { type: source.mimeType }), "original." + source.mimeType.split("/")[1]);
  body.set("response_format", "url");
  if (action === "vectorize") body.set("version", "v1_pro");
  else body.set("image_format", "png");
  await beforeSubmit();
  const response = await submit(`https://external.api.recraft.ai/v1/images/${recraftTools[action].endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body, redirect: "error", signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const message = `Recraft 处理失败（HTTP ${response.status}）`;
    throw isDefinitiveSubmissionRejection(response.status) || response.status === 402 ? new ProviderSubmissionRejected(message) : new Error(message);
  }
  const result = await response.json() as { image?: unknown };
  if (!isRecraftResult(result.image)) throw new RecraftOutputInvalid("Recraft 未返回可验证的原结果链接");
  await saveReceipt?.(result.image);
  return downloadRecraftResult(action, result.image);
}
