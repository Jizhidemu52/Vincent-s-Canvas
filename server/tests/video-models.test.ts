import { describe, expect, test } from "bun:test";
import {
  buildVideoProviderRequest,
  getVideoModelCapability,
  preflightVideoProviderRequest,
  supportedVideoModelIds,
  type ProviderVideoSource,
  videoTaskStatusPath,
} from "../src/video-models";

const image: ProviderVideoSource = {
  mimeType: "image/png",
  bytes: new Uint8Array([137, 80, 78, 71]),
};

const publicImage: ProviderVideoSource = {
  ...image,
  publicUrl: "https://assets.example.test/video-source.png?access=temporary-token",
};

describe("APIMart video model requests", () => {
  test("declares each provider's supported video limits", () => {
    expect(getVideoModelCapability("wan2.7")).toMatchObject({
      seconds: [2, 15],
      resolutions: ["720P", "1080P"],
      maxImages: 2,
    });
    expect(getVideoModelCapability("happyhorse-1.1")).toMatchObject({
      seconds: [3, 15],
      maxImages: 9,
    });
  });

  test("preflights video sources before a provider request can be submitted", () => {
    expect(() =>
      preflightVideoProviderRequest("wan2.7", "make it move", {}, [
        publicImage,
        publicImage,
        publicImage,
      ]),
    ).toThrow("wan2.7 accepts one first frame or a first and last frame");
  });

  test("uses the documented task-status path without unsupported query parameters", () => {
    expect(videoTaskStatusPath("task_01K8/with space")).toBe(
      "/tasks/task_01K8%2Fwith%20space",
    );
  });

  test("exposes exactly the four configured video models", () => {
    expect(supportedVideoModelIds).toEqual([
      "MiniMax-H3",
      "doubao-seedance-2.5",
      "wan2.7",
      "happyhorse-1.1",
    ]);
  });

  test("maps MiniMax H3 image-to-video to a publicly reachable first frame", () => {
    const request = buildVideoProviderRequest("MiniMax-H3", "make it move", { seconds: 3, resolution: "768p", size: "9:16" }, [publicImage]);

    expect(request.body).toMatchObject({
      model: "MiniMax-H3",
      prompt: "make it move",
      duration: 4,
      resolution: "768P",
      aspect_ratio: "9:16",
      first_frame_image: publicImage.publicUrl,
    });
    expect(request.body).not.toHaveProperty("image_urls");
  });

  test("uses the first selected frame when MiniMax H3 receives multiple images", () => {
    const secondImage: ProviderVideoSource = { mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]), publicUrl: "https://assets.example.test/end.jpg" };
    const request = buildVideoProviderRequest("MiniMax-H3", "make it move", {}, [publicImage, secondImage]);

    expect(request.body).toMatchObject({
      first_frame_image: publicImage.publicUrl,
    });
    expect(request.body).not.toHaveProperty("image_urls");
  });

  test("keeps Seedance automatic duration and adaptive framing", () => {
    const request = buildVideoProviderRequest("doubao-seedance-2.5", "make it move", { seconds: -1, resolution: "480P", size: "auto", generateAudio: false }, [publicImage]);

    expect(request.body).toMatchObject({
      model: "doubao-seedance-2.5",
      duration: -1,
      resolution: "480p",
      size: "adaptive",
      generate_audio: false,
      image_urls: [publicImage.publicUrl],
    });
  });

  test("maps Wan 2.7 image references with its native quality options", () => {
    const request = buildVideoProviderRequest("wan2.7", "make it move", { seconds: 1, resolution: "720p", size: "1:1" }, [publicImage]);

    expect(request.body).toMatchObject({
      model: "wan2.7",
      duration: 2,
      resolution: "720P",
      size: "1:1",
      image_urls: [publicImage.publicUrl],
      prompt_extend: true,
    });
  });

  test("rejects a local-only image before submitting it to a URL-only provider", () => {
    expect(() => buildVideoProviderRequest("MiniMax-H3", "make it move", {}, [image])).toThrow(
      "MiniMax-H3 requires an https:// or asset:// image URL",
    );
  });

  test("maps HappyHorse 1.1 single image to a publicly reachable first frame", () => {
    const request = buildVideoProviderRequest("happyhorse-1.1", "make it move", { seconds: 20, resolution: "720p", size: "4:3" }, [publicImage]);

    expect(request.body).toMatchObject({
      model: "happyhorse-1.1",
      duration: 15,
      resolution: "720P",
      size: "4:3",
      first_frame_image: publicImage.publicUrl,
    });
    expect(request.body).not.toHaveProperty("image_urls");
  });

  test("rejects a local-only HappyHorse image before charging a video task", () => {
    expect(() => buildVideoProviderRequest("happyhorse-1.1", "make it move", {}, [image])).toThrow(
      "happyhorse-1.1 requires an https:// or asset:// image URL",
    );
  });
});
