export type ApiMartImageModel = "gpt-image-2" | "gemini-3.1-flash-image-preview" | "midjourney" | "midjourney-blend";

export type ApiMartImageInput = {
  modelId: string;
  prompt: string;
  parameters: Record<string, unknown>;
  sourceDataUrls?: string[];
};

export type ApiMartImageRequest = {
  path: string;
  payload: Record<string, unknown>;
  pollIntervalMs: number;
  timeoutMs: number;
};

const GEMINI_MODELS = new Set([
  "gemini-3.1-flash-image-preview",
  "gemini-3.1-flash-image-preview-official",
  "nano-banana-2-ext",
  "nano-banana-2",
]);

const GPT_MODELS = new Set(["gpt-image-2", "gpt-image-2-ext"]);

const IMAGE_STATUSES = new Set(["pending", "submitted", "processing", "queued", "running"]);
const IMAGE_FAILURE_STATUSES = new Set(["failed", "cancelled", "canceled"]);

export function apiMartImageModel(modelId: string): ApiMartImageModel | null {
  const normalized = modelId.trim().toLowerCase();
  if (GPT_MODELS.has(normalized)) return "gpt-image-2";
  if (GEMINI_MODELS.has(normalized)) return "gemini-3.1-flash-image-preview";
  if (normalized === "midjourney-blend") return "midjourney-blend";
  if (normalized === "midjourney" || normalized === "midjourney-v7") return "midjourney";
  return null;
}

export function buildApiMartImageRequest(input: ApiMartImageInput): ApiMartImageRequest {
  const kind = apiMartImageModel(input.modelId);
  if (!kind) throw new Error(`不支持的 APIMart 图片模型：${input.modelId}`);

  const references = input.sourceDataUrls || [];
  if (kind === "midjourney-blend") {
    if (references.length < 2 || references.length > 4)
      throw new Error("Midjourney Blend requires 2 to 4 reference images");
    return {
      path: "/midjourney/generations/blend",
      payload: {
        image_urls: references,
        size: normalizeAspect(input.parameters.size),
        speed: normalizeMidjourneySpeed(input.parameters.midjourneySpeed),
      },
      pollIntervalMs: 2_000,
      timeoutMs: 15 * 60_000,
    };
  }
  if (kind === "midjourney") {
    if (references.length) throw new Error("Midjourney 文生图不支持此处上传参考图，请改用 GPT-Image-2 或 Gemini 图片模型");
    return {
      path: "/midjourney/generations",
      payload: {
        prompt: withMidjourneyAspect(input.prompt, input.parameters.size),
        size: normalizeAspect(input.parameters.size),
        version: String(input.parameters.midjourneyVersion || "6.1"),
        speed: normalizeMidjourneySpeed(input.parameters.midjourneySpeed),
      },
      pollIntervalMs: 2_000,
      timeoutMs: 15 * 60_000,
    };
  }

  const maximumReferences = kind === "gpt-image-2" ? 16 : 14;
  if (references.length > maximumReferences) {
    throw new Error(`${kind === "gpt-image-2" ? "GPT-Image-2" : "Gemini 3.1 Flash"} 最多支持 ${maximumReferences} 张参考图`);
  }

  const count = normalizeCount(input.parameters.count, 10);
  const payload: Record<string, unknown> = {
    model: normalizeModelId(kind, input.modelId),
    prompt: input.prompt,
    n: count,
    size: normalizeAspect(input.parameters.size),
    resolution: kind === "gpt-image-2" ? normalizeGptResolution(input.parameters.resolution) : normalizeGeminiResolution(input.parameters.resolution),
  };
  if (references.length) payload.image_urls = references;
  if (kind === "gemini-3.1-flash-image-preview") {
    if (input.parameters.officialFallback === true) payload.official_fallback = true;
    if (input.parameters.googleSearch === true) payload.google_search = true;
    if (input.parameters.googleImageSearch === true) {
      payload.google_search = true;
      payload.google_image_search = true;
    }
  }

  return { path: "/images/generations", payload, pollIntervalMs: 2_000, timeoutMs: 15 * 60_000 };
}

export async function runApiMartImageTask(input: ApiMartImageInput & { baseUrl: string; apiKey: string }): Promise<string[]> {
  if (!input.apiKey.trim()) throw new Error("APIMart 服务端 API Key 未配置");
  const request = buildApiMartImageRequest(input);
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" };
  const submit = await fetch(`${baseUrl}${request.path}`, {
    method: "POST", headers, body: JSON.stringify(request.payload), signal: AbortSignal.timeout(180_000),
  });
  if (!submit.ok) throw new Error(`APIMart 图片任务提交失败：${submit.status} ${await providerMessage(submit)}`);
  const taskId = readTaskId(await submit.json());
  if (!taskId) throw new Error("APIMart 图片任务未返回 task_id");

  const deadline = Date.now() + request.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(request.pollIntervalMs);
    const statusResponse = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${input.apiKey}` }, signal: AbortSignal.timeout(60_000),
    });
    if (!statusResponse.ok) throw new Error(`APIMart 图片任务状态查询失败：${statusResponse.status} ${await providerMessage(statusResponse)}`);
    const statusPayload = await statusResponse.json();
    const status = readStatus(statusPayload);
    const outputs = readOutputUrls(statusPayload);
    if (outputs.length) return outputs;
    if (IMAGE_FAILURE_STATUSES.has(status)) throw new Error(readFailureMessage(statusPayload) || "APIMart 图片任务失败");
    if (!IMAGE_STATUSES.has(status) && status) throw new Error(`APIMart 返回了未知任务状态：${status}`);
  }
  throw new Error("APIMart 图片任务超时");
}

function normalizeModelId(kind: ApiMartImageModel, modelId: string) {
  if (kind === "gpt-image-2") return "gpt-image-2";
  if (kind === "midjourney" || kind === "midjourney-blend") return "midjourney";
  return modelId.trim() === "nano-banana-2" ? "gemini-3.1-flash-image-preview-official" : "gemini-3.1-flash-image-preview";
}

function normalizeCount(value: unknown, maximum: number) {
  const count = Number(value ?? 1);
  return Number.isInteger(count) && count >= 1 ? Math.min(count, maximum) : 1;
}

function normalizeAspect(value: unknown) {
  const raw = String(value || "1:1").toLowerCase();
  if (raw === "auto") return "auto";
  const match = raw.match(/(?:^|[^0-9])(1:1|3:2|2:3|4:3|3:4|5:4|4:5|16:9|9:16|2:1|1:2|3:1|1:3|21:9|9:21|1:4|4:1|1:8|8:1)(?:$|[^0-9])/);
  if (match) return match[1]!;
  if (/^\d{3,5}x\d{3,5}$/.test(raw)) return raw;
  return "1:1";
}

function normalizeMidjourneySpeed(value: unknown) {
  const speed = String(value || "relax").toLowerCase();
  return speed === "fast" || speed === "turbo" ? speed : "relax";
}

function normalizeGptResolution(value: unknown) {
  const resolution = String(value || "1k").toLowerCase();
  return resolution === "2k" || resolution === "4k" ? resolution : "1k";
}

function normalizeGeminiResolution(value: unknown) {
  const resolution = String(value || "1k").toLowerCase();
  if (resolution === "0.5k") return "0.5K";
  if (resolution === "2k") return "2K";
  if (resolution === "4k") return "4K";
  return "1K";
}

function withMidjourneyAspect(prompt: string, size: unknown) {
  if (/--ar\s+\S+/i.test(prompt)) return prompt;
  const aspect = normalizeAspect(size);
  return aspect === "1:1" ? prompt : `${prompt.trim()} --ar ${aspect}`;
}

function readTaskId(value: unknown) {
  const record = object(value);
  const data = record.data;
  const first = Array.isArray(data) ? object(data[0]) : object(data);
  return string(first.task_id) || string(first.id) || string(record.task_id) || string(record.id);
}

function readStatus(value: unknown) {
  const record = object(value);
  return (string(object(record.data).status) || string(record.status) || "").toLowerCase();
}

function readOutputUrls(value: unknown): string[] {
  const record = object(value);
  const data = object(record.data);
  const result = object(data.result ?? record.result);
  const images = Array.isArray(result.images) ? result.images : [];
  return images.flatMap((image) => {
    const url = object(image).url;
    return Array.isArray(url) ? url.filter((item): item is string => typeof item === "string" && item.length > 0) : typeof url === "string" ? [url] : [];
  });
}

function readFailureMessage(value: unknown) {
  const record = object(value);
  return string(object(object(record.data).error).message) || string(object(record.error).message) || string(object(record.data).message) || string(record.message);
}

async function providerMessage(response: Response) {
  const body = await response.json().catch(() => null);
  return readFailureMessage(body) || "上游服务拒绝了请求";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
