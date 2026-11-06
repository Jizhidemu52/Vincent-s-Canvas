import { expect, test } from "bun:test";
import { buildVideoProviderRequest } from "../src/video-models";
import { prepareVideoProviderSources } from "../src/video-source-preparation";
import { videoFileExtension } from "../../shared/video-output";

test("Seedance forwards integer seed and both output formats; omitted seed remains random", () => {
  for (const seed of [0, -1, 2147483648, Number.MAX_SAFE_INTEGER]) for (const outputFormat of ["mp4", "mov"]) {
    expect(buildVideoProviderRequest("doubao-seedance-2.5", "one video", { seed, outputFormat }).body).toMatchObject({ seed, output_format: outputFormat });
  }
  expect(buildVideoProviderRequest("doubao-seedance-2.5", "one video").body).not.toHaveProperty("seed");
});

test("HappyHorse accepts only its documented seed range and has no invented format switch", () => {
  for (const seed of [0, "2147483647"]) expect(buildVideoProviderRequest("happyhorse-1.1", "one video", { seed }).body.seed).toBe(Number(seed));
  for (const seed of [-1, 2147483648]) expect(() => buildVideoProviderRequest("happyhorse-1.1", "one video", { seed })).toThrow("0–2147483647");
  expect(() => buildVideoProviderRequest("happyhorse-1.1", "one video", { outputFormat: "mov" })).toThrow("不支持此输出格式");
  expect(buildVideoProviderRequest("happyhorse-1.1", "one video").body).not.toHaveProperty("output_format");
});

test("invalid integer or format is rejected before the first provider upload", async () => {
  let requests = 0;
  for (const parameters of [{ seed: 1.5 }, { seed: Infinity }, { seed: true }, { seed: "x" }, { seed: Number.MAX_SAFE_INTEGER + 1 }, { outputFormat: "webm" }]) {
    await expect(prepareVideoProviderSources({ model: "doubao-seedance-2.5", prompt: "one video", parameters, sources: [{ mimeType: "image/png", bytes: new Uint8Array([1]), width: 300, height: 300 }], baseUrl: "https://fixture.invalid/v1", apiKey: "offline" }, { fetch: async () => { requests++; return Response.json({}); } })).rejects.toThrow();
  }
  expect(requests).toBe(0);
});

test("original video filenames reflect the container MIME, not the preview format", () => {
  expect(videoFileExtension("video/quicktime")).toBe("mov");
  expect(videoFileExtension("video/mp4")).toBe("mp4");
  expect(videoFileExtension("video/webm")).toBe("webm");
});
