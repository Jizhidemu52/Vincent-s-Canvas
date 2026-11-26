import { DOMParser } from "@xmldom/xmldom";
import { recraftTools, type RecraftAction } from "../../shared/recraft-tools";
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
      if (attr.name === "style" && /^\s*display\s*:\s*block\s*;?\s*$/.test(attr.value)) continue;
      if (!attrs.has(attr.name) || (!attr.name.startsWith("xmlns") && /[\\]|\/\*|url\s*\((?!#[\w.-]+\))/i.test(attr.value))) throw new Error("矢量结果包含不支持的属性");
    }
  }
}

export async function runRecraftImage(action: RecraftAction, source: { bytes: Uint8Array; mimeType: string }, beforeSubmit: () => Promise<void>, token = process.env.RECRAFT_API_TOKEN) {
  if (!token?.trim()) throw new Error("服务端尚未配置 Recraft API 密钥");
  await validateRecraftSource(action, source);
  const body = JSON.stringify({
    image_url: `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}`,
    response_format: "b64_json",
    ...(action === "vectorize" ? { version: "v1_pro" } : { image_format: "png" }),
  });
  await beforeSubmit();
  const response = await fetch(`https://external.api.recraft.ai/v1/images/${recraftTools[action].endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const message = `Recraft 处理失败（HTTP ${response.status}）`;
    throw isDefinitiveSubmissionRejection(response.status) || response.status === 402 ? new ProviderSubmissionRejected(message) : new Error(message);
  }
  const result = await response.json() as { image?: { b64_json?: string } };
  if (typeof result.image?.b64_json !== "string" || !result.image.b64_json.length) throw new Error("Recraft 未返回图片数据");
  const bytes = Buffer.from(result.image.b64_json, "base64");
  if (action === "vectorize") {
    assertRecraftVector(bytes);
    return { bytes, mimeType: "image/svg+xml" };
  }
  if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Recraft 未返回 PNG 图像");
  return { bytes, mimeType: "image/png" };
}
