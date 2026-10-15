import { expect, test } from "bun:test";
import { singleImageTaskParameters } from "../src/image-task-policy";

test.each(["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"])("%s forces one image for either provider without mutating saved input", operation => {
  const original = { n: 4, count: 10, resolution: "2k", quality: "high" };
  expect(singleImageTaskParameters(operation, original)).toEqual({ ...original, n: 1, count: 1 });
  expect(original).toEqual({ n: 4, count: 10, resolution: "2k", quality: "high" });
});
test("image policy neither changes video/audio nor limits independent task identities", () => {
  const input = { count: 3, seconds: 8 };
  for (const operation of ["video_generation", "audio_generation", "chat"]) expect(singleImageTaskParameters(operation, input)).toBe(input);
  expect(singleImageTaskParameters("image_generation", { requestId: "one" }).requestId).toBe("one");
  expect(singleImageTaskParameters("image_generation", { requestId: "two" }).requestId).toBe("two");
});
