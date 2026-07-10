import { describe, expect, test } from "bun:test";

import {
  buildOpenAiAudioRequest,
  buildOpenAiVideoFields,
  unwrapProviderEnvelope,
} from "../src/media-runtime";

describe("server media runtime", () => {
  test("builds bounded audio parameters without any browser credential", () => {
    expect(
      buildOpenAiAudioRequest("tts-v1", "欢迎使用", {
        voice: "nova",
        responseFormat: "wav",
        speed: 99,
        instructions: " 清晰自然 ",
      }),
    ).toEqual({
      payload: {
        model: "tts-v1",
        input: "欢迎使用",
        voice: "nova",
        response_format: "wav",
        speed: 4,
        instructions: "清晰自然",
      },
      mimeType: "audio/wav",
    });
  });

  test("normalizes video parameters and provider envelopes", () => {
    expect(
      buildOpenAiVideoFields("video-v1", "产品旋转展示", {
        seconds: 0,
        resolution: "1080p",
        timeoutSeconds: 99999,
      }),
    ).toEqual({
      model: "video-v1",
      prompt: "产品旋转展示",
      seconds: "1",
      size: "",
      resolution: "1080p",
      preset: "normal",
      timeoutSeconds: 7200,
    });
    expect(unwrapProviderEnvelope({ code: 0, data: { id: "task-1" } })).toEqual(
      { id: "task-1" },
    );
    expect(() =>
      unwrapProviderEnvelope({ code: 500, msg: "上游失败", data: null }),
    ).toThrow("上游失败");
  });
});
