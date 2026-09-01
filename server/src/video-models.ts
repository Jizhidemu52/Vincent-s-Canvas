export const supportedVideoModelIds = [
  "MiniMax-H3",
  "doubao-seedance-2.5",
  "wan2.7",
  "happyhorse-1.1",
] as const;

export type SupportedVideoModelId = (typeof supportedVideoModelIds)[number];

export type VideoModelCapability = {
  model: SupportedVideoModelId;
  seconds: readonly [number, number];
  resolutions: readonly string[];
  sizes: readonly string[];
  minImages: number;
  maxImages: number;
  firstFrameRequired: boolean;
  supportsAudio: boolean;
};

export type ProviderVideoSource = {
  mimeType: string;
  bytes: Uint8Array;
  /** A short-lived URL the upstream provider can retrieve directly. */
  publicUrl?: string;
};

export type VideoProviderParameters = {
  seconds?: unknown;
  size?: unknown;
  resolution?: unknown;
  watermark?: unknown;
  generateAudio?: unknown;
};

export type ProviderVideoRequest = {
  body: Record<string, unknown>;
  duration: number;
  resolution: string;
  size: string;
};

const standardRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const miniMaxRatios = ["21:9", ...standardRatios] as const;
const seedanceRatios = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] as const;

export const videoModelCapabilities: Record<SupportedVideoModelId, VideoModelCapability> = {
  "MiniMax-H3": {
    model: "MiniMax-H3",
    seconds: [4, 15],
    resolutions: ["768P", "2K"],
    sizes: miniMaxRatios,
    minImages: 0,
    maxImages: 1,
    firstFrameRequired: false,
    supportsAudio: false,
  },
  "doubao-seedance-2.5": {
    model: "doubao-seedance-2.5",
    seconds: [4, 30],
    resolutions: ["480p", "720p"],
    sizes: seedanceRatios,
    minImages: 0,
    maxImages: 30,
    firstFrameRequired: false,
    supportsAudio: true,
  },
  "wan2.7": {
    model: "wan2.7",
    seconds: [2, 15],
    resolutions: ["720P", "1080P"],
    sizes: standardRatios,
    minImages: 0,
    maxImages: 2,
    firstFrameRequired: false,
    supportsAudio: false,
  },
  "happyhorse-1.1": {
    model: "happyhorse-1.1",
    seconds: [3, 15],
    resolutions: ["720P", "1080P"],
    sizes: standardRatios,
    minImages: 0,
    maxImages: 9,
    firstFrameRequired: false,
    supportsAudio: false,
  },
};

export function isSupportedVideoModelId(value: unknown): value is SupportedVideoModelId {
  return supportedVideoModelIds.includes(value as SupportedVideoModelId);
}

export function getVideoModelCapability(model: SupportedVideoModelId) {
  return videoModelCapabilities[model];
}

export function videoTaskStatusPath(taskId: string) {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

export function buildVideoProviderRequest(
  model: SupportedVideoModelId,
  prompt: string,
  parameters: VideoProviderParameters = {},
  sources: ProviderVideoSource[] = [],
): ProviderVideoRequest {
  const images = sources.filter((source) => source.mimeType.startsWith("image/"));
  if (images.length !== sources.length) throw new Error("Only image references are supported for this video request");
  if (images.some((source) => source.bytes.byteLength > 10 * 1024 * 1024)) throw new Error("Each image must be 10MB or smaller");

  if (model === "MiniMax-H3") {
    const duration = clampDuration(parameters.seconds, 5, 4, 15);
    const resolution = normalizeResolution(parameters.resolution, ["2K", "768P"], "2K");
    const size = normalizeChoice(parameters.size, miniMaxRatios, "16:9");
    return {
      duration,
      resolution,
      size,
      body: {
        model,
        prompt,
        duration,
        resolution,
        aspect_ratio: size,
        ...(images[0] ? { first_frame_image: toRemoteImageUrl(model, images[0]) } : {}),
      },
    };
  }

  if (model === "doubao-seedance-2.5") {
    if (images.length > 30) throw new Error("doubao-seedance-2.5 accepts up to 30 image references");
    const duration = Number(parameters.seconds) === -1 ? -1 : clampDuration(parameters.seconds, 5, 4, 30);
    const resolution = normalizeResolution(parameters.resolution, ["480p", "720p"], "720p");
    const size = normalizeChoice(parameters.size === "auto" ? "adaptive" : parameters.size, seedanceRatios, "adaptive");
    return {
      duration,
      resolution,
      size,
      body: {
        model,
        prompt,
        duration,
        resolution,
        size,
        generate_audio: parameters.generateAudio !== false,
        watermark: parameters.watermark === true,
        ...(images.length ? { image_urls: images.map((image) => toRemoteImageUrl(model, image)) } : {}),
      },
    };
  }

  if (model === "wan2.7") {
    if (images.length > 2) throw new Error("wan2.7 accepts one first frame or a first and last frame");
    const duration = clampDuration(parameters.seconds, 5, 2, 15);
    const resolution = normalizeResolution(parameters.resolution, ["720P", "1080P"], "1080P");
    const size = normalizeChoice(parameters.size, standardRatios, "16:9");
    return {
      duration,
      resolution,
      size,
      body: {
        model,
        prompt,
        duration,
        resolution,
        size,
        prompt_extend: true,
        watermark: parameters.watermark === true,
        ...(images.length ? { image_urls: images.map((image) => toRemoteImageUrl(model, image)) } : {}),
      },
    };
  }

  if (images.length > 9) throw new Error("happyhorse-1.1 accepts up to 9 image references");
  const duration = clampDuration(parameters.seconds, 5, 3, 15);
  const resolution = normalizeResolution(parameters.resolution, ["720P", "1080P"], "1080P");
  const size = normalizeChoice(parameters.size, standardRatios, "16:9");
  return {
    duration,
    resolution,
    size,
    body: {
      model,
      prompt,
      duration,
      resolution,
      size,
      watermark: parameters.watermark === true,
      ...(images.length === 1
        ? { first_frame_image: toRemoteImageUrl(model, images[0]) }
        : images.length > 1
          ? { image_urls: images.map((image) => toRemoteImageUrl(model, image)) }
          : {}),
    },
  };
}

export function preflightVideoProviderRequest(
  model: SupportedVideoModelId,
  prompt: string,
  parameters: VideoProviderParameters = {},
  sources: ProviderVideoSource[] = [],
) {
  const request = buildVideoProviderRequest(model, prompt, parameters, sources);
  return {
    request,
    normalized: {
      seconds: request.duration,
      resolution: request.resolution,
      size: request.size,
      referenceCount: sources.length,
    },
  };
}

function clampDuration(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function normalizeResolution(value: unknown, options: readonly string[], fallback: string) {
  const normalized = String(value || "").replace(/p$/i, "P").toUpperCase();
  return options.find((option) => option.toUpperCase() === normalized) || fallback;
}

function normalizeChoice(value: unknown, options: readonly string[], fallback: string) {
  const selected = String(value || "");
  return options.includes(selected) ? selected : fallback;
}

function toRemoteImageUrl(model: SupportedVideoModelId, source: ProviderVideoSource) {
  const value = source.publicUrl?.trim() || "";
  if (/^https:\/\//i.test(value) || /^asset:\/\//i.test(value)) return value;
  throw new Error(`${model} requires an https:// or asset:// image URL`);
}
