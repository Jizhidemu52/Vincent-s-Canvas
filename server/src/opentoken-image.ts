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
    resolution?: "1k" | "2k" | "4k";
  };
  form?: FormData;
};

export function buildOpenTokenImageRequest(input: OpenTokenImageInput): OpenTokenImageRequest {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const references = input.references || [];
  const modelId = input.modelId || "gpt-image-2";
  const headers = { authorization: `Bearer ${input.apiKey}` };
  if (references.length) {
    const form = new FormData();
    form.set("model", modelId);
    form.set("prompt", input.prompt);
    form.set("n", "1");
    if (input.size) form.set("size", input.size);
    if (input.resolution) form.set("resolution", input.resolution);
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
      ...(input.size ? { size: input.size } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
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

export async function runOpenTokenImage(input: OpenTokenImageInput): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("OpenToken API key is not configured");
  const request = buildOpenTokenImageRequest(input);
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.form || JSON.stringify(request.body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`OpenToken image request failed: ${response.status}`);
  const result = parseOpenTokenImageResponse(await response.json());
  if ("base64" in result) return `data:image/png;base64,${result.base64}`;
  const image = await fetch(result.url, { signal: AbortSignal.timeout(120_000) });
  if (!image.ok) throw new Error(`OpenToken image download failed: ${image.status}`);
  const mimeType = image.headers.get("content-type")?.split(";")[0] || "image/png";
  return `data:${mimeType};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`;
}
