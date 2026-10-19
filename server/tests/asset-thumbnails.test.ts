import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createAssetThumbnailBytes } from "../src/asset-thumbnails";
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
