import { canvasToolKey } from "@/hooks/use-tool-config";
import { imageModelProfile } from "@/lib/image-model-settings";
import { resolveCapabilityModel } from "@/lib/model-picker-options";
import type { BusinessConfig } from "@/services/api/business-config";
import { applyToolModel } from "@/services/api/tool-runtime";
import type { AiConfig } from "@/stores/use-config-store";
import type { ToolKey } from "../../../../shared/feature-catalog";

/** Keep the canvas UI and both execution paths on the same effective model and tool. */
export function resolveCanvasImageConfig(base: AiConfig, business: BusinessConfig, hasImages: boolean): { config: AiConfig; toolKey: ToolKey; isBound: boolean } {
    const model = resolveCapabilityModel(base, "image", business.models, base.model);
    if (!model) throw new Error("所选模型暂不可用，请重新选择或联系管理员启用。");
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
        if (nextToolKey === toolKey) return { config, toolKey, isBound };
        toolKey = nextToolKey;
    }
    throw new Error("公共配置绑定模型与生成/编辑板块不一致，请检查模型绑定");
}
