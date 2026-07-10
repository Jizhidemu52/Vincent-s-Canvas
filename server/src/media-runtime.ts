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
