import { describe, expect, test } from "bun:test";
import { promptInputSchema } from "../../shared/prompt-contracts";
import { videoMotionParameters } from "../src/video-motion-input";
import { buildVideoProviderRequest, resolveVideoMode, type ProviderVideoSource, type SupportedVideoModelId, type VideoMode } from "../src/video-models";
import { preflightStoredVideoTask } from "../src/stored-video-preflight";

const motion = promptInputSchema.parse({ scene: "video-motion", mode: "video", fields: { audio: "none" } });
const sources = (count: number): ProviderVideoSource[] => Array.from({ length: count }, (_, index) => ({
  mimeType: "image/png", bytes: new Uint8Array([1]), byteSize: 1, width: 768, height: 960,
  publicUrl: `https://fixtures.example/image-${index}.png`,
}));
const modelModes: Array<[SupportedVideoModelId, Exclude<VideoMode, "auto">, Exclude<VideoMode, "auto">]> = [
  ["doubao-seedance-2.5", "first-frame", "first-last-frame"],
  ["MiniMax-H3", "first-frame", "reference"],
  ["wan2.7", "first-frame", "first-last-frame"],
  ["happyhorse-1.1", "first-frame", "reference"],
];

describe("motion planning uses the selected model's image mode", () => {
  for (const [model, oneImageMode, twoImageMode] of modelModes) {
    for (const count of [1, 2]) {
      test(`${model}: ${count} image(s) keep the intended automatic mode`, () => {
        for (const initial of [{}, { videoMode: "auto" }]) {
          const input = { ...initial, seconds: 5 };
          const snapshot = { ...input };
          const media = sources(count);
          const parameters = videoMotionParameters(input, motion, media.map(source => source.mimeType), model);
          expect(parameters).toMatchObject({ videoMode: count === 1 ? oneImageMode : twoImageMode, generateAudio: false, seconds: 5 });
          expect(buildVideoProviderRequest(model, "展示服装细节", parameters, media).mode).toBe(count === 1 ? oneImageMode : twoImageMode);
          expect(input).toEqual(snapshot);
        }
      });
    }
  }

  test("explicit modes remain authoritative, including invalid modes that preflight must reject", () => {
    for (const [model] of modelModes) {
      for (const videoMode of ["text", "first-frame", "first-last-frame", "reference", "invalid"]) {
        expect(videoMotionParameters({ videoMode }, motion, ["image/png", "image/png"], model)).toMatchObject({ videoMode });
      }
    }
    const parameters = videoMotionParameters({ videoMode: "first-last-frame" }, motion, ["image/png", "image/png"], "happyhorse-1.1");
    expect(() => buildVideoProviderRequest("happyhorse-1.1", "展示服装细节", parameters, sources(2))).toThrow("mode only");
  });

  test("HappyHorse legacy mode and new-mode precedence remain unchanged", () => {
    for (const happyHorseMode of ["reference", "text", "first-frame", "invalid"]) {
      const parameters = videoMotionParameters({ happyHorseMode }, motion, ["image/png"], "happyhorse-1.1");
      expect(parameters).toEqual({ happyHorseMode, generateAudio: false });
    }
    expect(videoMotionParameters({ videoMode: "auto", happyHorseMode: "reference" }, motion, ["image/png"], "happyhorse-1.1")).toEqual({ videoMode: "first-frame", happyHorseMode: "reference", generateAudio: false });
    expect(videoMotionParameters({ videoMode: "reference", happyHorseMode: "first-frame" }, motion, ["image/png"], "happyhorse-1.1")).toEqual({ videoMode: "reference", happyHorseMode: "first-frame", generateAudio: false });
  });

  test("mixed media are never forced into image frame modes", () => {
    for (const [model] of modelModes) {
      for (const mimeTypes of [["image/png", "video/mp4"], ["image/png", "audio/mpeg"], ["image/png", "image/png", "video/mp4"]]) {
        for (const initial of [{}, { videoMode: "auto" }]) {
          const parameters = videoMotionParameters(initial, motion, mimeTypes, model);
          expect(parameters).toEqual({ ...initial, generateAudio: false });
          const media = mimeTypes.map(mimeType => ({ mimeType, bytes: new Uint8Array([1]) }));
          expect(resolveVideoMode(model, parameters, media)).toBe(resolveVideoMode(model, initial, media));
        }
      }
    }
  });

  test("text-only and larger image sets leave automatic selection to the provider preflight", () => {
    for (const [model] of modelModes) {
      for (const count of [0, 3]) {
        expect(videoMotionParameters({ videoMode: "auto" }, motion, sources(count).map(source => source.mimeType), model)).toEqual({ videoMode: "auto", generateAudio: false });
      }
    }
  });

  test("raw input remains unchanged and motion audio retains the existing control", () => {
    const original = { videoMode: "auto", generateAudio: true, seconds: 10 };
    expect(videoMotionParameters(original, undefined, ["image/png", "image/png"], "happyhorse-1.1")).toEqual(original);
    const ambient = promptInputSchema.parse({ ...motion, fields: { audio: "ambient" } });
    expect(videoMotionParameters({}, ambient, ["image/png", "image/png"], "happyhorse-1.1")).toEqual({ videoMode: "reference", generateAudio: true });
  });
});

function storedFixture(model: SupportedVideoModelId) {
  const assets = sources(2).map((source, index) => ({ ...source, id: `30000000-0000-4000-8000-00000000000${index}`, objectKey: `owned/image-${index}.png` }));
  const db = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM model_configs")) return { rows: [{ modelId: model }] };
    if (sql.includes("FROM assets")) {
      expect(values[1]).toBe("owner");
      return { rows: assets.filter(asset => asset.id === values[0]) };
    }
    throw new Error(`Unexpected database operation: ${sql}`);
  } };
  const input = { userId: "owner", modelConfigId: "selected-model", prompt: "", promptInput: motion, parameters: { videoMode: "auto" }, sourceUrls: assets.map(asset => `/api/assets/${asset.id}/content`) };
  const reads: string[] = [];
  const runtime = {
    readSource: async (key: string) => { reads.push(key); return (async function* () { yield new Uint8Array([1]); })(); },
    probe: async () => ({ width: 768, height: 960 }),
  };
  return { db, input, runtime, reads };
}

describe("stored motion preflight passes its authoritative model", () => {
  for (const [model, , expectedMode] of modelModes) {
    test(`${model}: two owned images are admitted with the model's automatic mode`, async () => {
      const fixture = storedFixture(model);
      const checked = await preflightStoredVideoTask(fixture.db as never, fixture.input, "http://owned.example", fixture.runtime);
      expect(checked.normalized).toMatchObject({ videoMode: expectedMode, referenceCount: 2, generateAudio: false });
      expect(checked.snapshot.modelId).toBe(model);
      expect(fixture.reads).toEqual(["owned/image-0.png", "owned/image-1.png"]);
    });
  }

  test("an explicit unsupported mode preserves INVALID_VIDEO_INPUT and reads no media", async () => {
    const fixture = storedFixture("happyhorse-1.1");
    fixture.input.parameters.videoMode = "first-last-frame";
    await expect(preflightStoredVideoTask(fixture.db as never, fixture.input, "", fixture.runtime)).rejects.toMatchObject({ code: "INVALID_VIDEO_INPUT" });
    expect(fixture.reads).toEqual([]);
  });
});
