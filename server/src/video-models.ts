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
  /** Whether the channel exposes a generate_audio toggle; not whether output has native sound. */
  supportsAudio: boolean;
  supportsWatermark: boolean;
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
  happyHorseMode?: unknown;
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
    maxImages: 9,
    firstFrameRequired: false,
    supportsAudio: false,
    supportsWatermark: true,
  },
  "doubao-seedance-2.5": {
    model: "doubao-seedance-2.5",
    seconds: [4, 30],
    resolutions: ["480p", "720p", "1080p"],
    sizes: seedanceRatios,
    minImages: 0,
    maxImages: 30,
    firstFrameRequired: false,
    supportsAudio: true,
    supportsWatermark: true,
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
    supportsWatermark: true,
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
    supportsWatermark: true,
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
  if (["MiniMax-H3", "happyhorse-1.1"].includes(model) && images.some((image) => image.mimeType === "image/gif")) throw new Error(`${model} does not accept GIF reference images; use JPEG, PNG or WebP`);

  if (model === "MiniMax-H3") {
    if (images.length > 9) throw new Error("MiniMax-H3 accepts up to 9 image references");
    if (prompt.length > 7000) throw new Error("MiniMax-H3 prompt must be 7000 characters or fewer");
    const duration = clampDuration(parameters.seconds, 5, 4, 15);
    const resolution = normalizeResolution(parameters.resolution, ["2K", "768P"], "2K");
    const size = images.length === 1 ? "adaptive" : normalizeChoice(parameters.size, miniMaxRatios, "16:9");
    return {
      duration,
      resolution,
      size,
      body: {
        model,
        prompt,
        duration,
        resolution,
        ...(images.length !== 1 ? { aspect_ratio: size } : {}),
        watermark: parameters.watermark === true,
        ...(images.length === 1 ? { first_frame_image: toRemoteImageUrl(model, images[0]) } : images.length > 1 ? { image_urls: images.map((image) => toRemoteImageUrl(model, image)) } : {}),
      },
    };
  }

  if (model === "doubao-seedance-2.5") {
    if (images.length > 30) throw new Error("doubao-seedance-2.5 accepts up to 30 image references");
    const duration = Number(parameters.seconds) === -1 ? -1 : clampDuration(parameters.seconds, 5, 4, 30);
    const resolution = normalizeResolution(parameters.resolution, ["480p", "720p", "1080p"], "720p");
    const size = normalizeChoice(parameters.size === "auto" ? "adaptive" : parameters.size, seedanceRatios, "adaptive");
    return {
      duration,
      resolution,
      size,
      body: {
        model: "seedance-2.5",
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
    if (prompt.length > 5000) throw new Error("wan2.7 prompt must be 5000 characters or fewer");
    const duration = clampDuration(parameters.seconds, 5, 2, 15);
    const resolution = normalizeResolution(parameters.resolution, ["720P", "1080P"], "1080P");
    const size = images.length ? "adaptive" : normalizeChoice(parameters.size, standardRatios, "16:9");
    return {
      duration,
      resolution,
      size,
      body: {
        model,
        prompt,
        duration,
        resolution,
        ...(!images.length ? { size } : {}),
        prompt_extend: true,
        watermark: parameters.watermark === true,
        ...(images.length ? { image_urls: images.map((image) => toRemoteImageUrl(model, image)) } : {}),
      },
    };
  }

  if (images.length > 9) throw new Error("happyhorse-1.1 accepts up to 9 image references");
  if (prompt.length > 2500) throw new Error("happyhorse-1.1 prompt must be 2500 characters or fewer");
  const mode = parameters.happyHorseMode;
  if (mode !== undefined && !["text", "first-frame", "reference"].includes(String(mode))) throw new Error("happyhorse-1.1 supports text, first-frame or reference mode only");
  if (mode === "text" && images.length) throw new Error("happyhorse-1.1 text mode does not accept images");
  if (mode === "first-frame" && images.length !== 1) throw new Error("happyhorse-1.1 first-frame mode requires exactly one image");
  if (mode === "reference" && !images.length) throw new Error("happyhorse-1.1 reference mode requires 1 to 9 images");
  const firstFrame = images.length === 1 && mode !== "reference";
  const duration = clampDuration(parameters.seconds, 5, 3, 15);
  const resolution = normalizeResolution(parameters.resolution, ["720P", "1080P"], "1080P");
  const size = firstFrame ? "adaptive" : normalizeChoice(parameters.size, standardRatios, "16:9");
  return {
    duration,
    resolution,
    size,
    body: {
      model,
      prompt,
      duration,
      resolution,
      ...(!firstFrame ? { size } : {}),
      watermark: parameters.watermark === true,
      ...(firstFrame
        ? { first_frame_image: toRemoteImageUrl(model, images[0]) }
        : images.length > 0
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
