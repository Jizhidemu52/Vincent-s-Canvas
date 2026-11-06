import { createTemporaryMediaFile } from "./media-file";
import { open } from "node:fs/promises";
import { videoResultMimeType } from "./video-result-type";

export type BufferedProviderResult = { bytes: Uint8Array; mimeType: string };
export type FileProviderResult = { filePath: string; byteSize: number; mimeType: string; dispose: () => Promise<void> };
export type ProviderResult = BufferedProviderResult | FileProviderResult;

export async function downloadVideoResult(url: string, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<FileProviderResult> {
  const signal = AbortSignal.timeout(180_000);
  const response = await fetcher(url, { signal });
  const contentType = response.headers.get("content-type")?.split(";")[0] || "video/mp4";
  const mimeType = contentType === "application/octet-stream" ? "video/mp4" : contentType;
  if (!response.ok || !mimeType.startsWith("video/")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(!response.ok ? `视频下载失败（${response.status}）` : "上游返回的不是视频文件");
  }
  if (!response.body) throw new Error("视频结果为空");
  const file = await createTemporaryMediaFile(response.body, { signal, prefix: "canvas-video-result-" });
  try {
    const handle = await open(file.path, "r");
    let actualMime: string;
    try {
      const head = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      actualMime = await videoResultMimeType(head.subarray(0, bytesRead), contentType);
    } finally { await handle.close(); }
    return { filePath: file.path, byteSize: file.byteSize, mimeType: actualMime, dispose: file.dispose };
  } catch (error) { await file.dispose(); throw error; }
}

/** Cleanup must never turn a successfully paid task into an automatic retry. */
export async function disposeProviderResults(results: ProviderResult[]) {
  return Promise.allSettled(results.filter((result): result is FileProviderResult => "dispose" in result).map(async result => result.dispose()));
}
