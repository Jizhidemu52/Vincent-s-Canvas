import { buildVideoProviderRequest, isSupportedVideoModelId, videoTaskStatusPath, type ProviderVideoSource, type VideoProviderParameters } from "./video-models";
import { prepareVideoProviderSources } from "./video-source-preparation";
import { queryProviderTaskStatus } from "./provider-status-query";
import { isDefinitiveSubmissionRejection } from "./provider-submission-policy";
import { apiMartPollIntervalMs } from "./apimart-poll-interval";

export class VideoProviderFailure extends Error {}
export class VideoSubmissionClaimLost extends Error {}
export class VideoTaskPending extends Error {
  constructor(public readonly nextPollMs = 2_000) { super("视频仍在生成，等待下一次状态查询"); }
}

export type ApiMartVideoInput = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  parameters: VideoProviderParameters;
  sources?: ProviderVideoSource[];
  upstreamTaskId?: string | null;
  submissionStarted?: boolean;
  /** Persisted original submission time, preserved across worker restarts/resume. */
  submissionStartedAt?: string | Date | null;
  beforeSubmit: () => Promise<boolean>;
  onSubmitted: (id: string) => Promise<void>;
};
type VideoRuntime = { fetch?: (url: string, init?: RequestInit) => Promise<Response>; sleep?: (ms: number) => Promise<unknown>; now?: () => number };

/** Exactly one submission OR status query. Workers persist/schedule between steps. */
export async function stepApiMartVideoTask(input: ApiMartVideoInput, runtime: VideoRuntime = {}): Promise<
  { status: "pending"; upstreamTaskId: string; nextPollMs: number } | { status: "completed"; upstreamTaskId: string; url: string }
> {
  if (!input.apiKey.trim()) throw new Error("APIMart 视频服务端凭据未配置");
  if (!isSupportedVideoModelId(input.modelId)) throw new Error("当前 APIMart 视频模型尚不支持");
  const request = runtime.fetch || fetch;
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" };
  let upstreamId = input.upstreamTaskId;
  if (!upstreamId) {
    if (input.submissionStarted) throw new Error("视频提交状态未知；为避免重复收费，已停止自动提交，请核查上游任务");
    if (!input.prompt.trim()) throw new Error("请填写视频描述");
    const sources = input.sources || [];
    const uploadedSources = await prepareVideoProviderSources({ model: input.modelId, prompt: input.prompt, parameters: input.parameters, sources, baseUrl, apiKey: input.apiKey }, { fetch: request });
    const { body } = buildVideoProviderRequest(input.modelId, input.prompt.trim(), input.parameters, uploadedSources);
    if (!await input.beforeSubmit()) throw new VideoSubmissionClaimLost("视频提交已被其他执行器接管；不会重复生成");
    const submitted = await request(`${baseUrl}/videos/generations`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    if (!submitted.ok) {
      const detail = await readVideoProviderError(submitted, input.apiKey);
      const message = `APIMart 视频提交失败（${submitted.status}）${detail ? `：${detail}` : ""}`;
      if (isDefinitiveSubmissionRejection(submitted.status)) throw new VideoProviderFailure(message);
      throw new Error(message);
    }
    const created = await submitted.json() as { data?: Array<{ task_id?: string }> };
    upstreamId = created.data?.[0]?.task_id;
    if (!upstreamId) throw new Error("视频服务未返回任务编号；请核查上游状态，不会自动重复提交");
    await input.onSubmitted(upstreamId);
    return { status: "pending", upstreamTaskId: upstreamId, nextPollMs: 2_000 };
  }
  const response = await queryProviderTaskStatus(`${baseUrl}${videoTaskStatusPath(upstreamId)}`, headers, runtime);
  if (!response.ok) {
    const detail = await readVideoProviderError(response, input.apiKey);
    throw new Error(`APIMart 视频状态查询失败（${response.status}）${detail ? `：${detail}` : ""}`);
  }
  const result = await response.json() as { data?: { status?: string; error?: { message?: string }; result?: { videos?: unknown[] } } };
  if (["failed", "cancelled", "canceled"].includes(result.data?.status || "")) throw new VideoProviderFailure(result.data?.error?.message || "视频生成失败");
  if (result.data?.status !== "completed") return { status: "pending", upstreamTaskId: upstreamId, nextPollMs: apiMartPollIntervalMs(input.submissionStartedAt, 2_000, runtime.now?.()) };
  for (const video of result.data.result?.videos || []) {
    const item = video as { url?: string | string[]; video_url?: string; output_url?: string } | null;
    const url = typeof video === "string" ? video : item && typeof item === "object" ? (Array.isArray(item.url) ? item.url[0] : item.url) || item.video_url || item.output_url : null;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return { status: "completed", upstreamTaskId: upstreamId, url };
  }
  throw new Error("视频任务完成但没有可下载结果；可稍后重新查询原任务");
}

/** Retain the upstream rejection reason, not its whole response or request data. */
async function readVideoProviderError(response: Response, apiKey: string) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let body = "", bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024) return "";
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const payload = JSON.parse(body);
    const detail = [payload?.error?.message, payload?.data?.error?.message, payload?.message, payload?.msg, payload?.error]
      .find((value) => typeof value === "string" && value.trim());
    if (typeof detail !== "string") return "";
    return detail.split(apiKey).join("[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/https?:\/\/[^\s"<>]+/gi, "[URL]")
      .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
  } catch {
    // A broken/non-JSON body must not turn a definite HTTP rejection into an
    // uncertain submission, or erase the original status code.
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Demo/single-request callers retain the blocking convenience API. */
export async function runApiMartVideoTask(input: ApiMartVideoInput, runtime: VideoRuntime = {}) {
  const sleep = runtime.sleep || Bun.sleep;
  const pending = { ...input };
  let nextPollMs = 2_000;
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    if (pending.upstreamTaskId) await sleep(nextPollMs);
    const result = await stepApiMartVideoTask(pending, runtime);
    if (result.status === "completed") return result.url;
    pending.upstreamTaskId = result.upstreamTaskId;
    pending.submissionStarted = true;
    nextPollMs = result.nextPollMs;
  }
  throw new Error("视频状态查询超时；可恢复查询原任务，不会重新生成");
}

export function buildOpenAiAudioRequest(
  modelId: string,
  prompt: string,
  parameters: Record<string, unknown>,
) {
  const responseFormat = stringParameter(parameters.responseFormat, "mp3");
  return {
    payload: {
      model: modelId,
      input: prompt,
      voice: stringParameter(parameters.voice, "alloy"),
      response_format: responseFormat,
      speed: numberParameter(parameters.speed, 1, 0.25, 4),
      ...(typeof parameters.instructions === "string" &&
      parameters.instructions.trim()
        ? { instructions: parameters.instructions.trim() }
        : {}),
    },
    mimeType: audioMimeType(responseFormat),
  };
}

export function buildOpenAiVideoFields(
  modelId: string,
  prompt: string,
  parameters: Record<string, unknown>,
) {
  return {
    model: modelId,
    prompt,
    seconds: String(Math.round(numberParameter(parameters.seconds, 6, 1, 20))),
    size: stringParameter(parameters.size, ""),
    resolution: stringParameter(parameters.resolution, "720p"),
    preset: stringParameter(parameters.preset, "normal"),
    timeoutSeconds: numberParameter(parameters.timeoutSeconds, 1200, 30, 7200),
  };
}

export function unwrapProviderEnvelope(value: unknown) {
  if (value && typeof value === "object" && "data" in value) {
    const record = value as { code?: number; msg?: string; data?: unknown };
    if (typeof record.code === "number" && record.code !== 0)
      throw new Error(record.msg || "Provider 请求失败");
    return record.data;
  }
  return value;
}

function stringParameter(value: unknown, fallback: string) {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function numberParameter(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

function audioMimeType(format: string) {
  return format === "wav"
    ? "audio/wav"
    : format === "aac"
      ? "audio/aac"
      : format === "flac"
        ? "audio/flac"
        : format === "opus"
          ? "audio/ogg"
          : "audio/mpeg";
}
