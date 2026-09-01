import { expect, test } from "bun:test";

import { decodeInlineImageResult } from "../src/demo-task-result-assets";

test("decodes inline image results so task responses can use a compact asset URL", () => {
  expect(decodeInlineImageResult("data:image/png;base64,AAEC")).toEqual({
    mimeType: "image/png",
    bytes: new Uint8Array([0, 1, 2]),
  });
});

test("leaves provider URLs outside of the inline image storage path", () => {
  expect(decodeInlineImageResult("https://provider.example/image.png")).toBeNull();
});
