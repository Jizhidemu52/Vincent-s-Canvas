/** Public board contract only. Prompts and processing rules live exclusively on the server. */
export type QuickImageAction = "remove-background" | "hd-upscale";
export function quickImageModelId(action: QuickImageAction) {
  return action === "remove-background" ? "mai-image-2.6-flash" : "gemini-nano-banana-2.1";
}
export function isQuickImageAction(value: unknown): value is QuickImageAction {
  return value === "remove-background" || value === "hd-upscale";
}
/** Boards reuse existing permission and billing scopes; no new database binding is needed. */
export function quickImageTaskTarget(action: QuickImageAction, canvas = false) {
  return canvas ? { toolKey: "canvas-edit", operationType: "inpaint" } as const
    : action === "remove-background" ? { toolKey: "image-edit", operationType: "inpaint" } as const
    : { toolKey: "detail-enhance", operationType: "upscale" } as const;
}

export function matchesQuickImageTaskTarget(action: QuickImageAction, toolKey: unknown, operationType: string) {
  const target = quickImageTaskTarget(action, toolKey === "canvas-edit");
  return toolKey === target.toolKey && operationType === target.operationType;
}
