import { expect, test } from "bun:test";

import { preflightVideoTask } from "../src/video-task-preflight";

const image = {
  mimeType: "image/png",
  bytes: new Uint8Array([137, 80, 78, 71]),
  publicUrl: "https://assets.example.test/source.png",
};

test("normalizes a video task before any paid submission", () => {
  expect(
    preflightVideoTask({
      model: "happyhorse-1.1",
      prompt: "make the model walk forward",
      parameters: { seconds: 99, resolution: "720p", size: "4:3" },
      sources: [image],
    }),
  ).toMatchObject({
    normalized: { seconds: 15, resolution: "720P", size: "4:3", referenceCount: 1 },
  });
});

test("does not accept an empty video prompt", () => {
  expect(() =>
    preflightVideoTask({
      model: "happyhorse-1.1",
      prompt: "   ",
      parameters: {},
      sources: [],
    }),
  ).toThrow("Video prompt is required");
});
