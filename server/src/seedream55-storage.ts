import { createHash } from "node:crypto";
import type { LayerStudioItem, LayerStudioResultDocument } from "../../shared/layer-studio";
import { seedream55PublicDocument, type Seedream55Manifest } from "./seedream55-image";
import { isPublicHttpUrl } from "./apimart-upload";
import { readBoundedImage } from "./seedream55-reference";
import { fileTypeFromBuffer } from "file-type";
import { probeMediaBytes } from "./media-probe";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export type SavedLayerOriginal = { assetId: string; contentUrl: string; bytes: Uint8Array; mimeType: string; sha256: string; width: number; height: number };
export type LayerOriginal = Omit<SavedLayerOriginal, "assetId" | "contentUrl">;
export const hashLayerOriginal = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function downloadPinnedOriginal(url: string) {
  const node = Bun.which("node");
  if (!node) throw new Error("服务端缺少原生 Node.js 安全下载运行时");
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(node, ["--max-old-space-size=128", fileURLToPath(new URL("./seedream55-download-worker.mjs", import.meta.url))],
      { encoding: "buffer", timeout: 95_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) } }, (error, stdout) => error
        ? reject(new Error("图层原件安全下载失败（地址校验、网络或大小限制）；可恢复原任务继续保存")) : resolve(stdout));
    child.stdin?.on("error", () => {}); // Exit/error is reported by execFile.
    child.stdin?.end(url);
  });
}

export async function downloadLayerOriginal(url: string, fetcher?: (url: string, init: RequestInit) => Promise<Response>) {
  if (!isPublicHttpUrl(url)) throw new Error("结果地址必须为公开 HTTP(S)");
  let bytes: Buffer;
  if (fetcher) {
    // An explicit test transport cannot be selected by a task/user parameter.
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(90_000) });
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new Error(`图层原件下载失败（${response.status}）`); }
    bytes = await readBoundedImage(response.body, 64 * 1024 * 1024);
  } else bytes = await downloadPinnedOriginal(url);
  const mimeType = (await fileTypeFromBuffer(bytes))?.mime;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error("上游图层原件不是 PNG/JPEG");
  const { width, height } = await probeMediaBytes(bytes, mimeType);
  if (!width || !height) throw new Error("上游图层实际尺寸无法读取");
  return { bytes, mimeType, width, height, sha256: hashLayerOriginal(bytes) };
}

/** Exactly one original buffer at a time. Completed entries are hash-verified,
 * not downloaded/overwritten again. The manifest is persisted by the caller
 * before entering this function; failure preserves every completed item. */
export async function persistLayerOriginals(input: {
  taskId: string; manifest: Seedream55Manifest; document?: LayerStudioResultDocument | null;
  findSaved(index: number): Promise<SavedLayerOriginal | null>;
  download(url: string): Promise<LayerOriginal>;
  save(index: number, original: LayerOriginal, item: LayerStudioItem): Promise<{ assetId: string; contentUrl: string }>;
  checkpoint(document: LayerStudioResultDocument): Promise<void>;
}) {
  const document = input.document ? structuredClone(input.document) : seedream55PublicDocument(input.taskId, input.manifest);
  if (document.taskId !== input.taskId || document.items.length !== input.manifest.items.length || document.items.some((item, i) => item.index !== i || item.groupIndex !== input.manifest.items[i]!.public.groupIndex || item.urlIndex !== input.manifest.items[i]!.public.urlIndex)) throw new Error("图层原任务清单身份不一致，拒绝覆盖");
  document.status = "persisting";
  try {
    for (const [index, entry] of input.manifest.items.entries()) {
      const saved = await input.findSaved(index);
      if (!saved && document.items[index]!.state === "saved") throw new Error("已保存图层原件缺失，保留任务等待核查");
      const original = saved ?? await input.download(entry.url);
      if (hashLayerOriginal(original.bytes) !== original.sha256 || (document.items[index]!.sha256 && document.items[index]!.sha256 !== original.sha256)) throw new Error("已保存图层原件 hash 不一致，拒绝覆盖");
      if (entry.public.role === "layer" && original.mimeType !== "image/png") throw new Error("透明图层不是 PNG，保留原任务待核查");
      const identity = saved ?? await input.save(index, original, entry.public);
      document.items[index] = { ...entry.public, state: "saved", assetId: identity.assetId, contentUrl: identity.contentUrl, width: original.width, height: original.height, mimeType: original.mimeType, sha256: original.sha256 };
      await input.checkpoint(document);
    }
    document.status = "ready";
    await input.checkpoint(document);
    return document;
  } catch (error) {
    document.status = "partial";
    await input.checkpoint(document);
    throw error;
  }
}
