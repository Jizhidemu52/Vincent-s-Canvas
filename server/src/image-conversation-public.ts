import type { PublicImageConversationData } from "../../shared/image-conversation-public";

const publicErrorText = (text: string) => text.replace(/(?:APIMart\s+)?(?:gpt-image-2\.6-flare|Flare)|APIMart/gi, "图像服务");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (!record(value)) return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry)]));
  if (typeof value.modelConfigId === "string" && typeof value.model === "string") result.model = value.modelConfigId;
  if (value.policyVersion === "flare-auto-v1") result.policyVersion = "image-auto-v1";
  if (typeof value.code === "string" && typeof value.message === "string" && typeof value.retryable === "boolean") result.message = publicErrorText(value.message);
  if (value.kind === "status" && typeof value.text === "string"
    && (value.role === "assistant" || value.role === undefined && typeof value.canCancel === "boolean")) result.text = publicErrorText(value.text);
  if (typeof value.code === "string" && value.code !== "OK" && typeof value.msg === "string") {
    result.msg = publicErrorText(value.msg);
    if (record(result.data) && Array.isArray(result.data.fields)) result.data.fields = result.data.fields.map(field => record(field) && typeof field.message === "string"
      ? { ...field, message: publicErrorText(field.message) } : field);
  }
  return result;
}

export function toPublicImageConversationData<T>(value: T): PublicImageConversationData<T> {
  return project(value) as PublicImageConversationData<T>;
}
