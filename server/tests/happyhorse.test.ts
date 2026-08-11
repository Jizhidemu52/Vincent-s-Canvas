import { expect, test } from "bun:test";

import { toHappyHorseImageDataUrl } from "../src/happyhorse";

test("serializes a canvas PNG reference as a valid data URL", () => {
  expect(
    toHappyHorseImageDataUrl({
      mimeType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
    }),
  ).toBe("data:image/png;base64,iVBORw==");
});

test("rejects an image reference with an invalid MIME type", () => {
  expect(() =>
    toHappyHorseImageDataUrl({
      mimeType: "图片1",
      bytes: new Uint8Array([1]),
    }),
  ).toThrow("HappyHorse reference image MIME type is invalid");
});
