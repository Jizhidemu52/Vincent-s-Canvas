import { execFile } from "node:child_process";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type MediaMetadata = { width?: number; height?: number; durationMs?: number; fps?: number };
type ProbeOutput = { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string; r_frame_rate?: string; disposition?: { attached_pic?: number } }> };

const formats: Record<string, readonly string[]> = {
  "image/png": ["png_pipe"], "image/jpeg": ["jpeg_pipe"], "image/webp": ["webp_pipe"], "image/gif": ["gif"],
  "video/mp4": ["mov", "mp4"], "video/quicktime": ["mov", "mp4"],
  "audio/mpeg": ["mp3"], "audio/mp3": ["mp3"], "audio/wav": ["wav"], "audio/x-wav": ["wav"], "audio/wave": ["wav"],
};

/** Read the bytes, never a client URL or client-supplied dimensions/duration. */
export async function probeMediaBytes(bytes: Uint8Array, mimeType: string): Promise<MediaMetadata> {
  if (!formats[mimeType]) throw new Error("视频参考素材仅支持 JPEG/PNG/WebP/GIF、MP4/MOV、WAV/MP3");
  if (!bytes.byteLength || bytes.byteLength > 200 * 1024 * 1024) throw new Error("参考素材必须非空且不超过 200MB");
  const directory = await mkdtemp(join(tmpdir(), "canvas-media-probe-"));
  const file = join(directory, "source");
  try {
    await writeFile(file, bytes);
    const output = await new Promise<string>((resolve, reject) => {
      execFile(process.env.FFPROBE_PATH || "ffprobe", [
        "-v", "error", "-protocol_whitelist", "file,pipe",
        "-format_whitelist", "png_pipe,jpeg_pipe,webp_pipe,gif,mov,mp3,wav",
        "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,duration,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic",
        "-of", "json", file,
      ], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) reject(new Error((error as NodeJS.ErrnoException).code === "ENOENT"
          ? "服务端缺少 ffprobe，请安装 FFmpeg 或配置 FFPROBE_PATH 后重试；尚未提交生成"
          : "参考素材无法解析或读取超时，请检查文件是否损坏以及真实格式"));
        else resolve(stdout);
      });
    });
    return parseMediaProbe(JSON.parse(output), mimeType);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}

export function parseMediaProbe(output: ProbeOutput, mimeType: string): MediaMetadata {
  const container = output.format?.format_name?.split(",") || [];
  if (!formats[mimeType]?.some((name) => container.includes(name))) throw new Error("素材真实格式与声明类型不一致，请重新导入原文件");
  const kind = mimeType.startsWith("audio/") ? "audio" : "video";
  const stream = output.streams?.find((item) => item.codec_type === kind && !item.disposition?.attached_pic);
  if (!stream) throw new Error("素材没有可用的图像、视频或音频流");
  const result: MediaMetadata = {};
  if (kind === "video") {
    if (!Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width! <= 0 || stream.height! <= 0) throw new Error("无法读取素材真实尺寸");
    result.width = stream.width; result.height = stream.height;
  }
  if (!mimeType.startsWith("image/")) {
    const seconds = Math.max(Number(output.format?.duration) || 0, Number(stream.duration) || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("无法读取素材真实时长");
    result.durationMs = seconds * 1000;
    if (kind === "video") {
      const rate = (stream.avg_frame_rate && stream.avg_frame_rate !== "0/0" ? stream.avg_frame_rate : stream.r_frame_rate || "").split("/").map(Number);
      const fps = rate[0]! / (rate[1] ?? 1);
      if (!Number.isFinite(fps) || fps <= 0) throw new Error("无法读取视频真实帧率");
      result.fps = fps;
    }
  }
  return result;
}
