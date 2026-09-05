import { modelOptionName, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

export type ModelPickerSource = "server" | "local";
type CapabilityModel = { modelId: string; capabilities: readonly string[] };

export function resolveModelPickerSource(channelMode: AiConfig["channelMode"], source: ModelPickerSource | undefined, standalone: boolean): ModelPickerSource {
    // Existing company-edition callers use server APIs even though their effective config says "local".
    return source || (channelMode === "remote" || !standalone ? "server" : "local");
}

export function filterServerModelsByCapability<T extends CapabilityModel>(models: readonly T[], capability?: ModelCapability) {
    if (!capability) return [];
    const required = capability === "image" ? ["generate", "edit"] : [capability === "text" ? "chat" : capability];
    return models.filter((model) => !model.modelId.startsWith("demo-") && required.some((item) => model.capabilities.includes(item)));
}

export function getModelPickerOptions(config: AiConfig, capability: ModelCapability | undefined, models: readonly CapabilityModel[], source: ModelPickerSource, current?: string) {
    if (capability && source === "server") return Array.from(new Set(filterServerModelsByCapability(models, capability).map((model) => model.modelId)));
    return Array.from(new Set([...(config.channelMode === "local" && !capability ? [current] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model))));
}

export function resolveModelPickerValue(value: string | undefined, options: readonly string[], source: ModelPickerSource) {
    if (!value) return "";
    if (options.includes(value)) return value;
    const normalized = source === "server" ? modelOptionName(value) : value;
    return options.includes(normalized) ? normalized : "";
}

export function resolveCapabilityModel(config: AiConfig, capability: ModelCapability, models: readonly CapabilityModel[], current?: string, source: ModelPickerSource = "server") {
    const options = getModelPickerOptions(config, capability, models, source);
    return resolveModelPickerValue(current, options, source)
        || resolveModelPickerValue(config[`${capability}Model`], options, source)
        || options[0]
        || "";
}

export function modelCapabilityLabel(capability?: ModelCapability) {
    return capability === "image" ? "生图" : capability === "video" ? "视频" : capability === "text" ? "文本" : capability === "audio" ? "音频" : "";
}
