import { fetchProviderSubmission } from "./provider-submission-transport";
import type { GenerationTiming, GenerationTimingStage } from "./generation-timing";
import { openAiImageParameters, type OpenAiImageParameters } from "./openai-image-parameters";
export { normalizeOpenTokenImageSize } from "./openai-image-parameters";

export type OpenTokenReferenceImage = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

const openTokenImageModelIds = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gemini-3.1-flash-image"] as const;
export type OpenTokenImageModel = typeof openTokenImageModelIds[number];
export function isOpenTokenImageModel(value: unknown): value is OpenTokenImageModel {
  return openTokenImageModelIds.some(modelId => modelId === value);
}
export const OPENAI_IMAGE_TIMEOUT_MS = 600_000;

export type OpenTokenImageInput = OpenAiImageParameters & {
  baseUrl: string;
  apiKey: string;
  modelId?: OpenTokenImageModel;
  prompt: string;
  resolution?: "1k" | "2k" | "4k";
  references?: OpenTokenReferenceImage[];
  mask?: OpenTokenReferenceImage;
};

export type OpenTokenImageRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body?: OpenAiImageParameters & {
    model: OpenTokenImageModel;
    prompt: string;
    n: 1;
  };
  form?: FormData;
};

export function buildOpenTokenImageRequest(input: OpenTokenImageInput): OpenTokenImageRequest {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const references = input.references || [];
  const modelId = input.modelId || "gpt-image-2";
  const headers = { authorization: `Bearer ${input.apiKey}` };
  if (input.mask && !references.length) throw new Error("蒙版编辑必须提供原图");
  if (input.mask && modelId === "gemini-3.1-flash-image") throw new Error("当前模型没有已确认的蒙版编辑接口");
  const parameters = openAiImageParameters(input, modelId);
  if (references.length) {
    const form = new FormData();
    form.set("model", modelId);
    form.set("prompt", input.prompt);
    form.set("n", "1");
    for (const [key, value] of Object.entries(parameters)) form.set(key, String(value));
    for (const reference of references) {
      const bytes = new Uint8Array(reference.bytes).buffer;
      form.append("image", new Blob([bytes], { type: reference.mimeType }), reference.filename);
    }
    if (input.mask) form.set("mask", new Blob([new Uint8Array(input.mask.bytes).buffer], { type: input.mask.mimeType }), input.mask.filename);
    return { url: `${baseUrl}/images/edits`, method: "POST", headers, form };
  }
  return {
    url: `${baseUrl}/images/generations`,
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: {
      model: modelId,
      prompt: input.prompt,
      n: 1,
      ...parameters,
    },
  };
}

export function parseOpenTokenImageResponse(value: unknown): { url: string } | { base64: string } {
  const data = value && typeof value === "object" && "data" in value && Array.isArray(value.data) ? value.data : [];
  const first = data[0];
  if (first && typeof first === "object" && "url" in first && typeof first.url === "string" && first.url)
    return { url: first.url };
  if (first && typeof first === "object" && "b64_json" in first && typeof first.b64_json === "string" && first.b64_json)
    return { base64: first.b64_json };
  throw new Error("OpenToken did not return an image");
}

export function openTokenErrorMessage(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error as Record<string, unknown> : {};
  return typeof error.message === "string" && error.message.trim()
    ? error.message
    : typeof record.message === "string" && record.message.trim()
      ? record.message
      : "";
}

export async function runOpenTokenImage(input: OpenTokenImageInput, timing?: GenerationTiming): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("OpenToken API key is not configured");
  const measure = <T>(stage: GenerationTimingStage, action: () => Promise<T> | T) => timing ? timing.measure(stage, action) : action();
  const request = await measure("prepare", () => buildOpenTokenImageRequest(input));
  const response = await measure("provider_request", () => fetchProviderSubmission(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.form || JSON.stringify(request.body),
    signal: AbortSignal.timeout(OPENAI_IMAGE_TIMEOUT_MS),
  }).catch((error) => {
    throw new Error(`OpenToken image submission transport failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }));
  const result = await measure("provider_response", async () => {
    if (!response.ok) {
      const message = openTokenErrorMessage(await response.json().catch(() => null));
      throw new Error(`OpenToken image request failed: ${response.status}${message ? `: ${message}` : ""}`);
    }
    return parseOpenTokenImageResponse(await response.json());
  });
  if ("base64" in result) return `data:image/${request.body?.output_format || request.form?.get("output_format") || "png"};base64,${result.base64}`;
  const download = async () => {
    const image = await fetch(result.url, { signal: AbortSignal.timeout(120_000) }).catch((error) => {
      throw new Error(`OpenToken image result download transport failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    if (!image.ok) throw new Error(`OpenToken image download failed: ${image.status}`);
    const mimeType = image.headers.get("content-type")?.split(";")[0] || "image/png";
    return `data:${mimeType};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`;
  };
  return /^https?:\/\//i.test(result.url) ? measure("result_download", download) : download();
}
