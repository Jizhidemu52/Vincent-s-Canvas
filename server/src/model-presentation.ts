import { imageParameterProfile } from "./image-parameter-profile";

const imageCapabilities = ["generate", "edit", "upscale", "remove_background", "batch"];

export function isImageModel(model: Record<string, unknown>) {
  const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
  return imageCapabilities.some((capability) => capabilities.includes(capability))
    && !["chat", "video", "audio"].some((capability) => capabilities.includes(capability));
}

export function canSeeModelIdentity(role: unknown) {
  return role === "super_admin" || role === "department_admin";
}

export function publicModelName(model: Record<string, unknown>) {
  if (!isImageModel(model)) return String(model.name || "");
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
  return {
    id: model.id,
    name: hidden ? publicModelName(model) : model.name,
    modelId: hidden ? model.id : model.modelId,
    capabilities: model.capabilities,
    creditCost: model.creditCost,
    rmbCost: model.rmbCost,
    imageParameterProfile: hidden ? anonymousProfiles[profile] : profile,
    ...(image ? { publicName: publicModelName(model), modelIdentityHidden: hidden } : {}),
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
