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

function isOpenTokenModel(model: Record<string, unknown>) {
  if (model.providerId === MARK_IMAGE_PROVIDER_ID) return false;
  let openToken = String(model.providerName || "").trim().toLowerCase() === "opentoken";
  try {
    const hostname = new URL(String(model.providerBaseUrl || "")).hostname;
    openToken ||= hostname === "opentoken.io" || hostname.endsWith(".opentoken.io");
  } catch { /* A provider display name also identifies the local configuration. */ }
  return openToken;
}

function openTokenImageLabel(model: Record<string, unknown>) {
  const modelId = String(model.modelId);
  return isOpenTokenModel(model) && Object.hasOwn(openTokenImageLabels, modelId) ? openTokenImageLabels[modelId] : undefined;
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

export const MAX_FEATURED_MODELS = 5;

/** Eligibility is identity-based, never inferred from a provider or model display name. */
export function isFeaturedModelCandidate(model: Record<string, unknown>) {
  return isImageModel(model) && Boolean(markImageLabel(model))
    && Array.isArray(model.capabilities) && model.capabilities.includes("generate");
}

function defaultModelOrder(model: Record<string, unknown>) {
  const markIndex = MARK_PLATFORM_MODELS.findIndex(item => item.modelId === model.modelId);
  if (markImageLabel(model)) return markIndex;
  const openTokenIndex = Object.keys(openTokenImageLabels).indexOf(String(model.modelId));
  return MARK_PLATFORM_MODELS.length + (openTokenImageLabel(model) ? openTokenIndex : 100);
}

function availableFeaturedCandidate(model: Record<string, unknown>) {
  return isFeaturedModelCandidate(model) && model.enabled !== false && model.providerEnabled !== false;
}

export function defaultFeaturedModelIds(models: Array<Record<string, unknown>>) {
  return models.filter(availableFeaturedCandidate).sort((a, b) => defaultModelOrder(a) - defaultModelOrder(b))
    .slice(0, MAX_FEATURED_MODELS).map(model => String(model.id));
}

/** null means never configured; an explicitly saved [] must remain empty. */
export function resolveFeaturedModelIds(models: Array<Record<string, unknown>>, configuredIds: string[] | null) {
  if (configuredIds === null) return defaultFeaturedModelIds(models);
  const eligibleIds = new Set(models.filter(availableFeaturedCandidate).map(model => String(model.id)));
  return [...new Set(configuredIds)].filter(id => eligibleIds.has(id)).slice(0, MAX_FEATURED_MODELS);
}

export function applyModelPresentation<T extends Record<string, unknown>>(models: T[], configuredIds: string[] | null) {
  const featured = resolveFeaturedModelIds(models, configuredIds);
  return models.map(model => {
    const rank = featured.indexOf(String(model.id));
    return { ...model, isFeatured: rank >= 0, displayOrder: rank >= 0 ? rank : 1000 + defaultModelOrder(model) };
  });
}

export function canSeeModelIdentity(role: unknown) {
  return role === "super_admin" || role === "department_admin";
}

/** Curate creation choices only; retained configurations and history are not deleted. */
export function isSelectableCreativeModel(model: Record<string, unknown>) {
  if (Array.isArray(model.capabilities) && model.capabilities.includes("chat")) {
    if (model.providerId === MARK_IMAGE_PROVIDER_ID) {
      return model.protocol === "apimart" && ["claude-sonnet-5-5", "gpt-6-astra"].includes(String(model.modelId));
    }
    return isOpenTokenModel(model) && ["openai", "openai-chat"].includes(String(model.protocol)) && model.modelId === "gpt-6-astra";
  }
  return !isImageModel(model) || Boolean(creativeImageLabel(model));
}

export function selectCreativeModels<T extends Record<string, unknown>>(models: T[]): T[] {
  const seenChoices = new Set<string>();
  const selected = models.filter(model => {
    if (!isSelectableCreativeModel(model)) return false;
    if (!isImageModel(model) && !(Array.isArray(model.capabilities) && model.capabilities.includes("chat"))) return true;
    const identity = `${model.providerId || model.providerBaseUrl || model.providerName || ""}::${model.modelId}`;
    if (seenChoices.has(identity)) return false;
    seenChoices.add(identity);
    return true;
  });
  const order = (model: Record<string, unknown>) => typeof model.displayOrder === "number" && Number.isFinite(model.displayOrder)
    ? model.displayOrder : defaultModelOrder(model);
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
    isFeatured: isFeaturedModelCandidate(model) && model.isFeatured === true,
    displayOrder: typeof model.displayOrder === "number" && Number.isFinite(model.displayOrder)
      ? model.displayOrder : 1000 + defaultModelOrder(model),
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
