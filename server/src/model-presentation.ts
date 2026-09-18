import { imageParameterProfile } from "./image-parameter-profile";

const imageCapabilities = ["generate", "edit", "upscale", "remove_background", "batch"];

// Usage labels, not exclusive capabilities or quality guarantees. See the
// feature guide for the official model descriptions used for these names.
const openTokenImageLabels: Readonly<Record<string, { name: string; description: string }>> = {
  "gpt-image-2": { name: "日常生图", description: "直接描述，生成新图片" },
  "gpt-image-2.5-flare": { name: "快速试稿", description: "快速看效果，尝试不同设计方向" },
  "gpt-image-2.5-sunburst": { name: "细节精修", description: "已有图片，仔细调整局部细节" },
  "gemini-3.1-flash-image": { name: "备用生图", description: "前三个模型不合适时再试" },
};

function openTokenImageLabel(model: Record<string, unknown>) {
  let openToken = String(model.providerName || "").trim().toLowerCase() === "opentoken";
  try {
    const hostname = new URL(String(model.providerBaseUrl || "")).hostname;
    openToken ||= hostname === "opentoken.io" || hostname.endsWith(".opentoken.io");
  } catch { /* A provider display name also identifies the local configuration. */ }
  const modelId = String(model.modelId);
  return openToken && Object.hasOwn(openTokenImageLabels, modelId) ? openTokenImageLabels[modelId] : undefined;
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
  return !isImageModel(model) || Boolean(openTokenImageLabel(model));
}

export function selectCreativeModels<T extends Record<string, unknown>>(models: T[]): T[] {
  const seenImages = new Set<string>();
  const selected = models.filter(model => {
    if (!isSelectableCreativeModel(model)) return false;
    if (!isImageModel(model)) return true;
    const modelId = String(model.modelId);
    if (seenImages.has(modelId)) return false;
    seenImages.add(modelId);
    return true;
  });
  const imageOrder = Object.keys(openTokenImageLabels);
  const images = selected.filter(isImageModel).sort((a, b) => imageOrder.indexOf(String(a.modelId)) - imageOrder.indexOf(String(b.modelId)));
  let nextImage = 0;
  return selected.map(model => isImageModel(model) ? images[nextImage++]! : model);
}

export function publicModelName(model: Record<string, unknown>) {
  if (!isImageModel(model)) return String(model.name || "");
  const featureName = openTokenImageLabel(model)?.name;
  if (featureName) return featureName;
  const number = Number(model.publicNumber);
  return Number.isSafeInteger(number) && number > 0 ? `出图模型${number}` : "出图模型";
}

const anonymousProfiles = {
  standard: "standard", gpt: "pixel", gemini: "resolution", midjourney: "speed",
  "midjourney-blend": "blend", unverified: "unverified",
} as const;

/** Explicit allowlist: never expose extra provider/configuration fields from a row. */
export function presentPublicModel(model: Record<string, unknown>, role: unknown) {
  const image = isImageModel(model);
  const hidden = image && !canSeeModelIdentity(role);
  const profile = imageParameterProfile(model.protocol, model.modelId);
  const label = image ? openTokenImageLabel(model) : undefined;
  return {
    id: model.id,
    name: hidden ? publicModelName(model) : model.name,
    modelId: hidden ? model.id : model.modelId,
    capabilities: model.capabilities,
    creditCost: model.creditCost,
    rmbCost: model.rmbCost,
    imageParameterProfile: hidden ? anonymousProfiles[profile] : profile,
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
