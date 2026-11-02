import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createAssetThumbnailBytes, createAssetThumbnailDetails } from "../src/asset-thumbnails";
import { fileTypeFromBuffer } from "file-type";

function command(tool: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(tool, args, { windowsHide: true, encoding: 'buffer', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    if (input) child.stdin!.end(input);
  });
}
test('real ffmpeg creates 256/1024 aspect-preserving WebP without changing original bytes', async () => {
  const original = await command(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1600x900', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
  const before = createHash('sha256').update(original).digest('hex');
  const thumbs = await createAssetThumbnailBytes(original);
  expect(createHash('sha256').update(original).digest('hex')).toBe(before);
  for (const size of [256, 1024] as const) {
    expect((await fileTypeFromBuffer(thumbs[size]))?.mime).toBe('image/webp');
    const data = JSON.parse((await command(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', 'pipe:0'], thumbs[size])).toString());
    expect(data.streams[0].width).toBe(size);
    expect(data.streams[0].height).toBe(size * 9 / 16);
    expect(thumbs[size].length).toBeLessThan(original.length);
  }
}, 40_000);

test('real MP4 with audio first and WebM produce safe first-frame posters and measured duration without rewriting video', async () => {
  for (const format of ['mp4', 'webm']) {
    const original = await command(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=6',
      '-t', '1', '-map', '0:a', '-map', '1:v', '-c:a', format === 'mp4' ? 'aac' : 'libopus', '-c:v', format === 'mp4' ? 'libx264' : 'libvpx', '-pix_fmt', 'yuv420p',
      ...(format === 'mp4' ? ['-movflags', 'frag_keyframe+empty_moov'] : []), '-f', format, 'pipe:1']);
    const before = createHash('sha256').update(original).digest('hex');
    const { thumbnails, metadata } = await createAssetThumbnailDetails(original);
    expect(metadata.width).toBe(640); expect(metadata.height).toBe(360);
    expect(metadata.durationMs).toBeGreaterThanOrEqual(1000); expect(metadata.durationMs).toBeLessThan(1300);
    for (const size of [256, 1024] as const) expect((await fileTypeFromBuffer(thumbnails[size]))?.mime).toBe('image/webp');
    expect(createHash('sha256').update(original).digest('hex')).toBe(before);
  }
}, 40_000);
