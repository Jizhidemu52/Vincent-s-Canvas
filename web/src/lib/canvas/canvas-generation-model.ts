import { canvasToolKey } from "@/hooks/use-tool-config";
import { imageModelProfile } from "@/lib/image-model-settings";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import { getToolDefinition } from "../../../../shared/feature-catalog";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { BusinessConfig } from "@/services/api/business-config";
import { applyToolModel } from "@/services/api/tool-runtime";
import type { AiConfig } from "@/stores/use-config-store";
import type { ToolKey } from "../../../../shared/feature-catalog";

/** Keep the canvas UI and both execution paths on the same effective model and tool. */
export function resolveCanvasToolModel(toolKey: ToolKey, base: AiConfig, business: BusinessConfig, preserveExplicit = false) {
    const definition = getToolDefinition(toolKey)!;
    const capability = definition.operationType === "chat" ? "text" : definition.operationType === "video_generation" ? "video" : definition.operationType === "audio_generation" ? "audio" : "image";
    const models = business.models.filter(model => definition.capabilities.some(value => model.capabilities.includes(value)) && (toolKey !== "canvas-mask-edit" || imageModelProfile(model.modelId, business.models).supportsMask));
    const model = resolveCapabilityModel(base, capability, models, base.model);
    if (!model) throw new Error("当前功能的模型暂不可用，请刷新模型列表后选择其他模型。");
    const resolved = applyToolModel({ ...base, model, [`${capability}Model`]: model }, business, toolKey);
    if (!models.some(item => item.modelId === resolved.model)) throw new Error("当前功能绑定的模型不支持此操作，请更换板块模型配置。");
    if (preserveExplicit && resolved.model !== base.model) throw new Error("原生成模型当前不可用，未替换模型或提交任务；请恢复输入后手动选择新模型。");
    return resolved;
}

export async function ensureCanvasModelsReady() {
    const business = useBusinessConfigStore.getState();
    if (business.status !== "ready") {
        try { await business.refresh(); } catch { throw new Error("模型列表加载失败，请稍后重试；尚未提交生成。"); }
    }
    return useBusinessConfigStore.getState();
}

export function resolveCanvasImageConfig(base: AiConfig, business: BusinessConfig, hasImages: boolean, preserveExplicit = false): { config: AiConfig; toolKey: ToolKey; isBound: boolean } {
    const initialKey = canvasToolKey("image", hasImages, imageModelProfile(base.model, business.models).kind);
    const required = getToolDefinition(initialKey)!.capabilities;
    const candidates = business.models.filter(item => required.some(capability => item.capabilities.includes(capability)));
    const model = resolveCapabilityModel(base, "image", candidates, base.model);
    if (!model) throw new Error("当前功能的模型暂不可用，请刷新模型列表后选择其他模型。");
    let config: AiConfig = { ...base, model, imageModel: model };
    const route = (modelId: string) => canvasToolKey("image", hasImages, imageModelProfile(modelId, business.models).kind);
    let toolKey = route(config.model);
    let isBound = false;
    // A binding may change Blend into an editing model (or vice versa). Resolve
    // the new board once too; alternating bindings are invalid, never a fallback.
    for (let attempt = 0; attempt < 2; attempt++) {
        config = applyToolModel(config, business, toolKey);
        isBound ||= business.tools.some(tool => tool.toolKey === toolKey && Boolean(tool.modelConfigId));
        const nextToolKey = route(config.model);
        if (nextToolKey === toolKey) {
            const capabilities = business.models.find(item => item.modelId === config.model)?.capabilities || [];
            if (!getToolDefinition(toolKey)!.capabilities.some(value => capabilities.includes(value))) throw new Error("当前板块模型不支持此操作，请切换具备对应能力的模型。");
            if (preserveExplicit && config.model !== base.model) throw new Error("原生成模型当前不可用，未替换模型或提交任务；请恢复输入后手动选择新模型。");
            return { config, toolKey, isBound };
        }
        toolKey = nextToolKey;
    }
    throw new Error("公共配置绑定模型与生成/编辑板块不一致，请检查模型绑定");
}
