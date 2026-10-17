import { useMemo } from "react";
import { getToolDefinition, type ToolKey } from "../../../shared/feature-catalog";
import { applyToolModel } from "@/services/api/tool-runtime";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { AiConfig } from "@/stores/use-config-store";
import { useModuleEnabled } from "@/stores/use-module-store";

export function canvasToolKey(mode: string, editing = false, imageProfile?: string): ToolKey {
    return mode === "text" ? "canvas-chat" : mode === "video" ? "canvas-video" : mode === "audio" ? "canvas-audio" : editing && imageProfile !== "midjourney-blend" ? "canvas-edit" : "canvas-image";
}

export function useToolEnabled(toolKey: ToolKey) {
    const moduleEnabled = useModuleEnabled(toolKey);
    const disabled = useBusinessConfigStore(state => state.tools.some(item => item.toolKey === toolKey && item.enabled === false));
    return moduleEnabled && !disabled;
}

export function currentToolConfig(config: AiConfig, toolKey: ToolKey): AiConfig {
    const business = useBusinessConfigStore.getState();
    const managedChat = getToolDefinition(toolKey)?.operationType === "chat";
    if (managedChat && business.status !== "ready") throw new Error("对话服务配置尚未就绪，请稍后重试。");
    if (!managedChat && !business.tools.some(item => item.toolKey === toolKey && item.modelConfigId)) return config;
    return applyToolModel(config, business, toolKey);
}

/** Do not overwrite a user's saved selection when an administrator binds a tool. */
export function useToolConfig(config: AiConfig, toolKey: ToolKey) {
    const models = useBusinessConfigStore(state => state.models);
    const tools = useBusinessConfigStore(state => state.tools);
    const status = useBusinessConfigStore(state => state.status);
    return useMemo(() => {
        const managedChat = getToolDefinition(toolKey)?.operationType === "chat";
        if (managedChat && status !== "ready") return { ...config, model: "", textModel: "" };
        if (!managedChat && !tools.some(item => item.toolKey === toolKey && item.modelConfigId)) return config;
        try { return applyToolModel(config, { models, tools, prices: [] }, toolKey); }
        catch { return managedChat ? { ...config, model: "", textModel: "" } : { ...config, model: "", imageModel: "", videoModel: "", textModel: "", audioModel: "" }; }
    }, [config, models, tools, status, toolKey]);
}
