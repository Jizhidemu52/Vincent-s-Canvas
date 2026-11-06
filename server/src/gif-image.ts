import { execFile } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Decode a bounded number of GIF frames with the installed media parser; never re-encode. */
export async function inspectGifFrames(bytes: Uint8Array) {
  const invalid = () => new Error("渠道返回的 GIF 动画不完整或不包含 2–16 个有效帧；原件已保留，不会自动重新生成");
  if (bytes.length < 14 || bytes.length > 50 * 1024 * 1024 || bytes.at(-1) !== 0x3b
    || !["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("ascii"))) throw invalid();
  const directory = await mkdtemp(join(tmpdir(), "canvas-gif-result-")), file = join(directory, "original.gif");
  try {
    await writeFile(file, bytes);
    const output = await new Promise<string>((resolve, reject) => {
      execFile(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-err_detect", "explode", "-max_alloc", "134217728", "-threads", "1",
        "-protocol_whitelist", "file,pipe", "-format_whitelist", "gif", "-read_intervals", "%+#17", "-count_frames",
        "-show_entries", "format=format_name:stream=codec_type,width,height,nb_read_frames", "-of", "json", file],
      { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        if (error || stderr.trim()) reject(invalid());
        else resolve(stdout);
      });
    });
    const info = JSON.parse(output) as { format?: { format_name?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; nb_read_frames?: string }> };
    const stream = info.streams?.[0], width = stream?.width, height = stream?.height, frames = Number(stream?.nb_read_frames);
    if (info.format?.format_name !== "gif" || info.streams?.length !== 1 || stream?.codec_type !== "video"
      || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! < 1 || height! < 1
      || width! > 3840 || height! > 3840 || width! * height! > 16_777_216 || !Number.isInteger(frames) || frames < 2 || frames > 16) throw invalid();
    await new Promise<void>((resolve, reject) => {
      execFile(process.env.FFMPEG_PATH || "ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode",
        "-max_alloc", "134217728", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "gif",
        "-i", file, "-map", "0:v:0", "-frames:v", "17", "-f", "null", "-"],
      { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => error || stderr.trim() ? reject(invalid()) : resolve());
    });
    return { width: width!, height: height!, frames };
  } finally {
    await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}
