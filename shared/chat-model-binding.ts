export const CANVAS_DESIGN_CHAT_TOOL_KEY = "canvas-design-chat";

export function missingChatModelMessage(toolKey: string) {
  return toolKey === CANVAS_DESIGN_CHAT_TOOL_KEY ? "管理员尚未配置自由画布设计讨论模型" : "管理员尚未配置统一对话模型";
}
