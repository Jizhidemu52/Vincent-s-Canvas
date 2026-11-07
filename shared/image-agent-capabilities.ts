export const IMAGE_AGENT_VISION_REQUIRED_MESSAGE = "当前对话模型不支持看图，请联系管理员更换";

export function imageAgentProfileRequiresVision(profile: unknown): boolean {
    return profile === "creative-chat" || profile === "canvas-assistant";
}

/** Only administrator-managed capabilities establish support; model names are not evidence. */
export function imageAgentModelSupportsVision(capabilities: unknown): boolean {
    return Array.isArray(capabilities) && capabilities.includes("vision");
}

export function imageAgentVisionError(profile: unknown, capabilities: unknown): string | null {
    return imageAgentProfileRequiresVision(profile) && !imageAgentModelSupportsVision(capabilities)
        ? IMAGE_AGENT_VISION_REQUIRED_MESSAGE : null;
}
