import { describe, expect, test } from "bun:test";
import { parseMediaProbe, probeMediaBytes } from "../src/media-probe";

describe("server-owned media metadata", () => {
  test("reads real PNG dimensions and WAV duration without client metadata", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1cAAAAASUVORK5CYII=", "base64");
    expect(await probeMediaBytes(png, "image/png")).toEqual({ width: 1, height: 1 });
    const wav = Buffer.alloc(44 + 16000 * 2 * 4);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    expect(await probeMediaBytes(wav, "audio/wav")).toEqual({ durationMs: 4000 });
    await expect(probeMediaBytes(wav, "video/mp4")).rejects.toThrow("真实格式");
  });

  test("rejects corrupt media and playlist content without following external URLs", async () => {
    await expect(probeMediaBytes(Buffer.from("not a movie"), "video/mp4")).rejects.toThrow("无法解析");
    await expect(probeMediaBytes(Buffer.from("#EXTM3U\n#EXTINF:3\nhttp://127.0.0.1/private\n"), "video/mp4")).rejects.toThrow("无法解析");
  });

  test("uses container/stream duration and rational frame rates, never cover art", () => {
    const output = { format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "4.5" }, streams: [
      { codec_type: "video", width: 1, height: 1, disposition: { attached_pic: 1 } },
      { codec_type: "video", width: 768, height: 768, duration: "4", avg_frame_rate: "24000/1001" },
    ] };
    expect(parseMediaProbe(output, "video/mp4")).toMatchObject({ durationMs: 4500, width: 768, height: 768 });
    expect(parseMediaProbe(output, "video/mp4").fps).toBeCloseTo(23.976, 3);
    expect(() => parseMediaProbe({ ...output, streams: [{ codec_type: "audio" }] }, "video/mp4")).toThrow("可用");
    expect(() => parseMediaProbe({ ...output, streams: [{ codec_type: "video", width: 768, height: 768 }] }, "video/mp4")).toThrow("帧率");
  });
});
