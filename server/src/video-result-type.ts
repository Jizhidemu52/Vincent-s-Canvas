import { fileTypeFromBuffer } from "file-type";

/** The container bytes take precedence over a CDN's generic or incorrect header. */
export async function videoResultMimeType(head: Uint8Array, reported?: string | null) {
  const detected = (await fileTypeFromBuffer(head))?.mime;
  const declared = reported?.split(";")[0]?.trim().toLowerCase();
  const mime = detected || (declared && declared !== "application/octet-stream" ? declared : "video/mp4");
  if (!mime.startsWith("video/")) throw new Error("上游返回的不是视频文件");
  return mime;
}
