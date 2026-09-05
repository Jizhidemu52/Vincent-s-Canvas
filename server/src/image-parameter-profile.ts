/** Public UI capability hint; never includes provider addresses or credentials. */
export function imageParameterProfile(protocol: unknown, modelId: unknown) {
  const model = String(modelId).toLowerCase();
  if (protocol !== "apimart") return model === "gemini-3.1-flash-image" ? "unverified" : "standard";
  if (model.includes("midjourney-blend")) return "midjourney-blend";
  if (model.includes("midjourney")) return "midjourney";
  if (model.includes("gemini") || model.includes("nano-banana")) return "gemini";
  if (model.includes("gpt-image-2") || model.includes("vcen-gpt2")) return "gpt";
  return "standard";
}
