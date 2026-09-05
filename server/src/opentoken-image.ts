export type OpenTokenReferenceImage = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type OpenTokenImageModel = "gpt-image-2" | "gemini-3.1-flash-image";

export type OpenTokenImageInput = {
  baseUrl: string;
  apiKey: string;
  modelId?: OpenTokenImageModel;
  prompt: string;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  resolution?: "1k" | "2k" | "4k";
  references?: OpenTokenReferenceImage[];
};

export type OpenTokenImageRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body?: {
    model: OpenTokenImageModel;
    prompt: string;
    n: 1;
    size?: string;
    quality?: "low" | "medium" | "high" | "auto";
  };
  form?: FormData;
};

export function buildOpenTokenImageRequest(input: OpenTokenImageInput): OpenTokenImageRequest {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const references = input.references || [];
  const modelId = input.modelId || "gpt-image-2";
  const headers = { authorization: `Bearer ${input.apiKey}` };
  const size = modelId === "gemini-3.1-flash-image" ? undefined : normalizeOpenTokenImageSize(input.size);
  const quality = modelId === "gemini-3.1-flash-image" ? undefined : normalizeOpenTokenImageQuality(input.quality, input.resolution);
  if (references.length) {
    const form = new FormData();
    form.set("model", modelId);
    form.set("prompt", input.prompt);
    form.set("n", "1");
    if (size) form.set("size", size);
    if (quality) form.set("quality", quality);
    for (const reference of references) {
      const bytes = new Uint8Array(reference.bytes).buffer;
      form.append("image", new Blob([bytes], { type: reference.mimeType }), reference.filename);
    }
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
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
    },
  };
}

export function normalizeOpenTokenImageSize(value?: string) {
  const size = String(value || "1024x1024").trim().toLowerCase();
  if (size === "auto") return "auto";
  if (size === "1024x1024" || size.includes("1:1")) return "1024x1024";
  if (size === "1536x1024" || /16:9|4:3|3:2|landscape/.test(size)) return "1536x1024";
  if (size === "1024x1536" || /9:16|3:4|2:3|portrait/.test(size)) return "1024x1536";
  return "1024x1024";
}

function normalizeOpenTokenImageQuality(
  quality?: OpenTokenImageInput["quality"],
  resolution?: OpenTokenImageInput["resolution"],
) {
  if (quality === "low" || quality === "medium" || quality === "high" || quality === "auto") return quality;
  return resolution === "4k" ? "high" : resolution === "2k" ? "medium" : "low";
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

export async function runOpenTokenImage(input: OpenTokenImageInput): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("OpenToken API key is not configured");
  const request = buildOpenTokenImageRequest(input);
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.form || JSON.stringify(request.body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const message = openTokenErrorMessage(await response.json().catch(() => null));
    throw new Error(`OpenToken image request failed: ${response.status}${message ? `: ${message}` : ""}`);
  }
  const result = parseOpenTokenImageResponse(await response.json());
  if ("base64" in result) return `data:image/png;base64,${result.base64}`;
  const image = await fetch(result.url, { signal: AbortSignal.timeout(120_000) });
  if (!image.ok) throw new Error(`OpenToken image download failed: ${image.status}`);
  const mimeType = image.headers.get("content-type")?.split(";")[0] || "image/png";
  return `data:${mimeType};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`;
}
