import { imageParameterProfile } from "./image-parameter-profile";
import { MARK_PLATFORM_MODELS, MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";

const imageCapabilities = ["generate", "edit", "upscale", "remove_background", "batch"];

// Show upstream model IDs as labels; usage descriptions are not quality guarantees.
const openTokenImageLabels: Readonly<Record<string, { name: string; description: string }>> = {
  "gpt-image-2": { name: "gpt-image-2", description: "日常最通用模型" },
  "gpt-image-2.5-flare": { name: "gpt-image-2.5-flare", description: "快速出方案与常规改图" },
  "gpt-image-2.5-sunburst": { name: "gpt-image-2.5-sunburst", description: "精细改图与细节表现" },
  "gemini-3.1-flash-image": { name: "gemini-3.1-flash-image", description: "商品改款与参考图编辑" },
};

function openTokenImageLabel(model: Record<string, unknown>) {
  if (model.providerId === MARK_IMAGE_PROVIDER_ID) return undefined;
  let openToken = String(model.providerName || "").trim().toLowerCase() === "opentoken";
  try {
    const hostname = new URL(String(model.providerBaseUrl || "")).hostname;
    openToken ||= hostname === "opentoken.io" || hostname.endsWith(".opentoken.io");
  } catch { /* A provider display name also identifies the local configuration. */ }
  const modelId = String(model.modelId);
  return openToken && Object.hasOwn(openTokenImageLabels, modelId) ? openTokenImageLabels[modelId] : undefined;
}

function markImageLabel(model: Record<string, unknown>) {
  return model.providerId === MARK_IMAGE_PROVIDER_ID && model.protocol === "apimart"
    ? MARK_PLATFORM_MODELS.find(item => item.modelId === model.modelId && (item.capabilities as readonly string[]).includes("generate")) : undefined;
}

function markPlatformLabel(model: Record<string, unknown>) {
  return model.providerId === MARK_IMAGE_PROVIDER_ID && model.protocol === "apimart"
    ? MARK_PLATFORM_MODELS.find(item => item.modelId === model.modelId) : undefined;
}

function creativeImageLabel(model: Record<string, unknown>) {
  return markImageLabel(model) || openTokenImageLabel(model);
}

export function isImageModel(model: Record<string, unknown>) {
  const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
  return imageCapabilities.some((capability) => capabilities.includes(capability))
    && !["chat", "video", "audio"].some((capability) => capabilities.includes(capability));
}

export function canSeeModelIdentity(role: unknown) {
  return role === "super_admin" || role === "department_admin";
}

/** Curate creation choices only; retained configurations and history are not deleted. */
export function isSelectableCreativeModel(model: Record<string, unknown>) {
  return !isImageModel(model) || Boolean(creativeImageLabel(model));
}

export function selectCreativeModels<T extends Record<string, unknown>>(models: T[]): T[] {
  const seenImages = new Set<string>();
  const selected = models.filter(model => {
    if (!isSelectableCreativeModel(model)) return false;
    if (!isImageModel(model)) return true;
    const identity = `${model.providerId || model.providerBaseUrl || model.providerName || ""}::${model.modelId}`;
    if (seenImages.has(identity)) return false;
    seenImages.add(identity);
    return true;
  });
  const imageOrder = Object.keys(openTokenImageLabels);
  const order = (model: Record<string, unknown>) => markImageLabel(model)
    ? imageOrder.length + MARK_PLATFORM_MODELS.findIndex(item => item.modelId === model.modelId)
    : imageOrder.indexOf(String(model.modelId));
  const images = selected.filter(isImageModel).sort((a, b) => order(a) - order(b));
  let nextImage = 0;
  return selected.map(model => isImageModel(model) ? images[nextImage++]! : model);
}

export function publicModelName(model: Record<string, unknown>) {
  if (!isImageModel(model)) return String(model.name || "");
  const featureName = creativeImageLabel(model)?.name;
  if (featureName) return featureName;
  const number = Number(model.publicNumber);
  return Number.isSafeInteger(number) && number > 0 ? `出图模型${number}` : "出图模型";
}

const anonymousProfiles = {
  "standard-flex": "standard-flex", "standard-flex-plus": "standard-flex-plus",
  standard: "standard", gpt: "pixel", gemini: "resolution", midjourney: "speed",
  "midjourney-blend": "blend", unverified: "unverified",
  "quality-resolution": "quality-resolution", "resolution-1k": "resolution-1k",
  "grok-image": "grok-image",
} as const;

/** Explicit allowlist: never expose extra provider/configuration fields from a row. */
export function presentPublicModel(model: Record<string, unknown>, role: unknown) {
  const image = isImageModel(model);
  const hidden = image && !canSeeModelIdentity(role);
  const profile = imageParameterProfile(model.protocol, model.modelId, model.providerId);
  const mark = markPlatformLabel(model);
  const label = image ? creativeImageLabel(model) : mark;
  return {
    id: model.id,
    name: label?.name || (hidden ? publicModelName(model) : model.name),
    // Mark shares upstream IDs with OpenToken; all creation roles select its configuration UUID.
    // The admin configuration endpoint still returns the actual upstream modelId.
    modelId: hidden || mark ? model.id : model.modelId,
    ...(!image && mark ? { parameterModelId: mark.modelId } : {}),
    capabilities: model.capabilities,
    creditCost: model.creditCost,
    rmbCost: model.rmbCost,
    imageParameterProfile: hidden ? anonymousProfiles[profile] : profile,
    ...(image && mark ? { imageSupportsMask: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(mark.modelId) } : {}),
    ...(mark?.modelId === "gemini-3.1-flash-image-preview-official" ? { imageSupportsOfficialFallback: false } : {}),
    ...(image ? { publicName: publicModelName(model), modelIdentityHidden: hidden } : {}),
    ...(label ? { publicDescription: label.description } : {}),
  };
}

export function presentAdminModel(model: Record<string, unknown>) {
  return { ...model, ...(isImageModel(model) ? { publicName: publicModelName(model) } : {}) };
}

/** Demo configuration is in memory. Assign once from the full catalog, not the visible list. */
export function assignDemoPublicModelNumbers(models: Array<Record<string, unknown>>) {
  let next = Math.max(0, ...models.map((model) => Number(model.publicNumber) || 0));
  for (const model of models) {
    if (isImageModel(model) && !String(model.modelId).startsWith("demo-") && !model.publicNumber) {
      model.publicNumber = ++next;
    }
  }
}
