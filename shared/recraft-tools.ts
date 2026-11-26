export const recraftProviderId = "d718f582-371a-43e1-8808-12eb1d85f7c0";
export const recraftTools = {
  "remove-background": { id: "d718f582-371a-43e1-8808-12eb1d85f7c1", endpoint: "removeBackground", label: "一键去背景" },
  "hd-upscale": { id: "d718f582-371a-43e1-8808-12eb1d85f7c2", endpoint: "crispUpscale", label: "高清放大" },
  vectorize: { id: "d718f582-371a-43e1-8808-12eb1d85f7c3", endpoint: "vectorize", label: "图片转矢量图" },
} as const;
export type RecraftAction = keyof typeof recraftTools;
export function isRecraftAction(action: unknown): action is RecraftAction {
  return typeof action === "string" && Object.hasOwn(recraftTools, action);
}
