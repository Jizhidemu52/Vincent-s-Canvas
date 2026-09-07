import { isApiMartImageMimeType } from "./apimart-upload";

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
  byteSize?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
};

export type VideoMode = "auto" | "text" | "first-frame" | "last-frame" | "first-last-frame" | "reference" | "edit" | "extend";

export type VideoProviderParameters = {
  seconds?: unknown;
  size?: unknown;
  resolution?: unknown;
  watermark?: unknown;
  generateAudio?: unknown;
  happyHorseMode?: unknown;
  videoMode?: unknown;
};

export type ProviderVideoRequest = {
  body: Record<string, unknown>;
  duration: number;
  resolution: string;
  size: string;
  mode: Exclude<VideoMode, "auto">;
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

export function videoSourceMetadata(metadata: Record<string, unknown> | undefined) {
  const result: Pick<ProviderVideoSource, "durationMs" | "width" | "height" | "fps"> = {};
  for (const key of ["durationMs", "width", "height", "fps"] as const) {
    if (metadata?.[key] !== undefined) result[key] = Number(metadata[key]);
  }
  return result;
}

export function resolveVideoMode(model: SupportedVideoModelId, parameters: VideoProviderParameters, sources: ProviderVideoSource[]): Exclude<VideoMode, "auto"> {
  const explicit = parameters.videoMode ?? (model === "happyhorse-1.1" ? parameters.happyHorseMode : undefined);
  const allowed: Record<SupportedVideoModelId, VideoMode[]> = {
    "MiniMax-H3": ["auto", "text", "first-frame", "last-frame", "first-last-frame", "reference"],
    "doubao-seedance-2.5": ["auto", "text", "first-frame", "first-last-frame", "reference", "edit", "extend"],
    "wan2.7": ["auto", "text", "first-frame", "first-last-frame", "extend"],
    "happyhorse-1.1": ["auto", "text", "first-frame", "reference"],
  };
  if (explicit !== undefined && !allowed[model].includes(explicit as VideoMode)) throw new Error(`${model} supports ${allowed[model].join(", ")} mode only`);
  if (explicit && explicit !== "auto") return explicit as Exclude<VideoMode, "auto">;
  const images = sources.filter((s) => s.mimeType.startsWith("image/")).length;
  const video = sources.some((s) => s.mimeType.startsWith("video/"));
  const audio = sources.some((s) => s.mimeType.startsWith("audio/"));
  if (model === "wan2.7") return video ? "extend" : images === 2 ? "first-last-frame" : images ? "first-frame" : "text";
  if (model === "doubao-seedance-2.5") return sources.length ? "reference" : "text";
  return video || audio || images > 1 ? "reference" : images === 1 ? "first-frame" : "text";
}

/** All known media properties are checked before upload, claiming or charging a task. */
export function validateVideoSources(model: SupportedVideoModelId, parameters: VideoProviderParameters, sources: ProviderVideoSource[]) {
  const images = sources.filter((s) => s.mimeType.startsWith("image/"));
  const videos = sources.filter((s) => s.mimeType.startsWith("video/"));
  const audios = sources.filter((s) => s.mimeType.startsWith("audio/"));
  const mode = resolveVideoMode(model, parameters, sources);
  if (images.length + videos.length + audios.length !== sources.length) throw new Error("视频素材仅支持图片、MP4/MOV 视频、WAV/MP3 音频格式");
  const capability = getVideoModelCapability(model);
  if (images.length > capability.maxImages) throw new Error(model === "wan2.7" ? "wan2.7 accepts one first frame or a first and last frame" : `${model} accepts up to ${capability.maxImages} image references`);
  const videoLimit = model === "MiniMax-H3" ? 3 : model === "doubao-seedance-2.5" ? 10 : model === "wan2.7" ? 1 : 0;
  const audioLimit = model === "MiniMax-H3" ? 3 : model === "doubao-seedance-2.5" ? 10 : model === "wan2.7" ? 1 : 0;
  if (videos.length > videoLimit || audios.length > audioLimit) throw new Error(`${model} 最多支持 ${videoLimit} 个视频和 ${audioLimit} 个音频素材`);
  if (mode === "text" && (images.length || videos.length || (audios.length && model !== "wan2.7"))) throw new Error(`${model} text mode does not accept images or reference media`);
  const frame = ["first-frame", "last-frame", "first-last-frame"].includes(mode);
  if (frame && images.length !== (mode === "first-last-frame" ? 2 : 1)) throw new Error(`${model} ${mode} mode requires exactly ${mode === "first-last-frame" ? "two" : "one"} image(s)`);
  if (frame && (videos.length || (audios.length && model !== "wan2.7"))) throw new Error("首尾帧模式不可混合参考视频或参考音频");
  if (mode === "reference" && !sources.length) throw new Error(`${model} reference mode requires reference media`);
  if (model === "MiniMax-H3" && audios.length && !images.length && !videos.length) throw new Error("MiniMax-H3 音频不能单独作为参考，必须搭配参考图或视频");
  if (["edit", "extend"].includes(mode) && !videos.length) throw new Error("编辑或续写模式至少需要一个视频");
  if (model === "wan2.7" && mode === "extend" && (images.length > 1 || audios.length)) throw new Error("Wan 续写仅允许一个视频和可选的一张尾帧，不可搭配音频或首帧");
  if (model === "wan2.7" && mode === "extend" && videos.some((video) => video.durationMs !== undefined && video.durationMs >= Number(parameters.seconds ?? 5) * 1000)) throw new Error("Wan 续写的输出总时长必须大于源视频时长，请增加生成时长");
  for (const source of sources) {
    const image = source.mimeType.startsWith("image/");
    const video = source.mimeType.startsWith("video/");
    if (image && !isApiMartImageMimeType(source.mimeType)) throw new Error("视频参考图仅支持 JPEG、PNG、WebP 或 GIF 格式");
    if (image && ["MiniMax-H3", "happyhorse-1.1"].includes(model) && source.mimeType === "image/gif") throw new Error(`${model} does not accept GIF reference images; use JPEG, PNG or WebP`);
    if (video && !["video/mp4", "video/quicktime"].includes(source.mimeType)) throw new Error("参考视频仅支持 MP4/MOV 格式");
    if (!image && !video && !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"].includes(source.mimeType)) throw new Error("参考音频仅支持 WAV/MP3 格式");
    const maximum = image ? 10 : !video ? 15 : model === "MiniMax-H3" ? 50 : model === "wan2.7" ? 100 : 200;
    const byteSize = Math.max(source.bytes.byteLength, source.byteSize ?? 0);
    if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > maximum * 1024 * 1024) throw new Error(`素材必须非空且不超过 ${maximum}MB`);
    for (const key of ["durationMs", "width", "height", "fps"] as const) {
      if (source[key] !== undefined && (!Number.isFinite(source[key]) || source[key]! <= 0)) throw new Error(`素材 ${key} 必须是有效正数`);
    }
    if (!image && source.durationMs !== undefined) {
      const min = video && mode === "edit" ? 4000 : 2000;
      const max = model === "MiniMax-H3" ? 15000 : video && model === "wan2.7" ? 10000 : 30000;
      if (source.durationMs < min || source.durationMs > max) throw new Error(`素材时长必须在 ${min / 1000}–${max / 1000} 秒内`);
    }
    const { width, height } = source;
    if (image && model === "happyhorse-1.1" && mode === "first-frame" && width !== undefined && height !== undefined && (Math.min(width, height) < 300 || width / height < 0.4 || width / height > 2.5)) throw new Error("HappyHorse 首帧短边至少 300px，宽高比需在 0.4–2.5 之间");
    if (video && model !== "wan2.7" && source.fps !== undefined && (source.fps < (model === "MiniMax-H3" ? 23.976 : 24) || source.fps > 60)) throw new Error(`${model} 视频帧率不符合要求`);
    if (video || (image && ["MiniMax-H3", "doubao-seedance-2.5"].includes(model))) {
      const [min, max, minRatio, maxRatio] = model === "MiniMax-H3" ? [256, 5760, 0.4, 2.5] : model === "wan2.7" ? [240, 4096, 0.125, 8] : [300, 6000, 0.4, 2.5];
      if ([width, height].some((edge) => edge !== undefined && (edge < min! || edge > max!))) throw new Error(`${model} 素材尺寸或宽高比超出范围`);
      if (width === undefined || height === undefined) continue;
      if (width / height < minRatio! || width / height > maxRatio!) throw new Error(`${model} 素材尺寸或宽高比超出范围`);
      if (video && model === "doubao-seedance-2.5" && (width * height < 409600 || width * height > 8295044)) throw new Error("Seedance 视频总像素必须在 409600–8295044 之间");
    }
  }
  for (const group of [videos, audios]) {
    const total = group.reduce((sum, source) => sum + (source.durationMs || 0), 0);
    if (total > (model === "MiniMax-H3" ? 15000 : 30000)) throw new Error("参考素材总时长超出模型限制");
  }
  return { images, videos, audios, mode };
}

export function buildVideoProviderRequest(
  model: SupportedVideoModelId,
  prompt: string,
  parameters: VideoProviderParameters = {},
  sources: ProviderVideoSource[] = [],
): ProviderVideoRequest {
  const { images, videos, audios, mode } = validateVideoSources(model, parameters, sources);
  const frame = ["first-frame", "last-frame", "first-last-frame"].includes(mode);
  const urls = (items: ProviderVideoSource[]) => items.map((item) => toRemoteImageUrl(model, item));
  const imageUrls = urls(images), videoUrls = urls(videos), audioUrls = urls(audios);
  const maximumPrompt = model === "MiniMax-H3" ? 7000 : model === "wan2.7" ? 5000 : model === "happyhorse-1.1" ? 2500 : 20000;
  if (prompt.length > maximumPrompt) throw new Error(`${model} prompt must be ${maximumPrompt} characters or fewer`);
  const capability = getVideoModelCapability(model);
  const duration = model === "doubao-seedance-2.5" && (mode === "edit" || Number(parameters.seconds) === -1) ? -1 : clampDuration(parameters.seconds, 5, ...capability.seconds);
  const resolution = normalizeResolution(parameters.resolution, capability.resolutions, model === "MiniMax-H3" ? "2K" : model === "doubao-seedance-2.5" ? "720p" : "1080P");
  const adaptive = frame || (model === "doubao-seedance-2.5" && ["edit", "extend"].includes(mode)) || (model === "wan2.7" && videos.length > 0);
  const size = adaptive ? "adaptive" : normalizeChoice(parameters.size === "auto" ? "adaptive" : parameters.size, capability.sizes, model === "doubao-seedance-2.5" ? "adaptive" : "16:9");
  const body: Record<string, unknown> = { model: model === "doubao-seedance-2.5" ? "seedance-2.5" : model, prompt, duration, resolution, watermark: parameters.watermark === true };
  if (model === "MiniMax-H3") {
    if (!frame) body.aspect_ratio = size;
    if (mode === "first-frame" || mode === "first-last-frame") body.first_frame_image = imageUrls[0];
    if (mode === "last-frame" || mode === "first-last-frame") body.last_frame_image = imageUrls[mode === "first-last-frame" ? 1 : 0];
    if (!frame && images.length) body.image_urls = imageUrls;
    if (videos.length) body.video_urls = videoUrls;
    if (audios.length) body.audio_urls = audioUrls;
  } else if (model === "doubao-seedance-2.5") {
    body.size = size;
    body.generate_audio = parameters.generateAudio !== false;
    if (frame) body.image_with_roles = imageUrls.map((url, index) => ({ url, role: index ? "last_frame" : "first_frame" }));
    else if (images.length) body.image_urls = imageUrls;
    if (videos.length) body.video_urls = videoUrls;
    if (audios.length) body.audio_urls = audioUrls;
    if (["reference", "edit", "extend"].includes(mode)) body.omni_reference_task_type = mode;
  } else if (model === "wan2.7") {
    if (!images.length && !videos.length) body.size = size;
    body.prompt_extend = true;
    if (mode === "extend") {
      body.video_urls = videoUrls;
      if (images.length) body.image_with_roles = [{ url: imageUrls[0], role: "last_frame" }];
    } else if (images.length) body.image_urls = imageUrls;
    if (audios.length) body.audio_url = audioUrls[0];
  } else {
    if (!frame) body.size = size;
    if (frame) body.first_frame_image = imageUrls[0];
    else if (images.length) body.image_urls = imageUrls;
  }
  return { body, duration, resolution, size, mode };
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
      videoMode: request.mode,
      upstreamBillingSeconds: (request.duration === -1 ? 30 : request.duration) + (model === "doubao-seedance-2.5" ? sources.filter((source) => source.mimeType.startsWith("video/")).reduce((total, source) => total + (source.durationMs || 0) / 1000, 0) : 0),
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
