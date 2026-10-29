import { uiText, useUiLocale } from "@/lib/i18n";
import { useEffect, useId, useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import { CanvasModelPicker } from "@/components/canvas/canvas-model-picker";
import { canvasImageModelDetails, canvasModelPresentation } from "@/lib/canvas/canvas-model-picker-options";
import { imageModelProfile } from "@/lib/image-model-settings";
import { referencePolicyForModel } from "@/lib/image-reference-policy";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useCanManageConfig } from "@/hooks/use-can-manage-config";
import { cn } from "@/lib/utils";
import { standaloneEdition } from "@/lib/standalone-edition";
import { deploymentFeatures } from "@/lib/deployment-features";
import { imageModelDisplayName, imageModelIdentityHidden } from "@/lib/model-display";
import { emitModelUsage } from "@/lib/usage-control-events";
import { modelOptionLabel, modelOptionName, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { filterServerModelsByCapability, getModelPickerOptions, modelCapabilityLabel, modelLabelWithUsage, resolveModelPickerSource, resolveModelPickerValue, type ModelPickerSource } from "@/lib/model-picker-options";
import { getToolDefinition, type ToolKey } from "../../../shared/feature-catalog";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    modelsSource?: ModelPickerSource;
    disabled?: boolean;
    toolKey?: ToolKey;
    variant?: "default" | "canvas";
};

export function shouldRefreshModelPickerConfig(capability: ModelCapability | undefined, status: "idle" | "loading" | "ready" | "error", source: ModelPickerSource = "server") {
    return source === "server" && Boolean(capability) && status === "idle";
}

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder = uiText("选择模型"), onMissingConfig, modelsSource, disabled = false, toolKey, variant }: ModelPickerProps) {
    useUiLocale();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const canManageConfig = useCanManageConfig();
    const businessConfigStatus = useBusinessConfigStore((state) => state.status);
    const refreshBusinessConfig = useBusinessConfigStore((state) => state.refresh);
    const businessModels = useBusinessConfigStore((state) => state.models);
    const binding = useBusinessConfigStore(state => state.tools.find(item => item.toolKey === toolKey));
    const boundModel = binding?.modelConfigId ? businessModels.find(item => item.id === binding.modelConfigId) : undefined;
    const source = resolveModelPickerSource(config.channelMode, modelsSource ?? (capability ? "server" : undefined), standaloneEdition);
    const usesServerModels = source === "server" && Boolean(capability);
    const serverModels = useMemo(() => usesServerModels && businessConfigStatus === "ready" ? filterServerModelsByCapability(businessModels, capability)
        .filter(item => !binding?.modelConfigId || item.id === binding.modelConfigId)
        .filter(item => !toolKey || !getToolDefinition(toolKey)?.capabilities.length || getToolDefinition(toolKey)!.capabilities.some(capability => item.capabilities.includes(capability)))
        .filter(item => toolKey !== "midjourney-blend" || item.imageParameterProfile === "blend" || item.imageParameterProfile === "midjourney-blend" || item.modelId === "midjourney-blend") : [], [businessConfigStatus, businessModels, capability, usesServerModels, binding?.modelConfigId, toolKey]);
    useEffect(() => {
        if (!shouldRefreshModelPickerConfig(capability, businessConfigStatus, source)) return;
        void refreshBusinessConfig().catch(() => undefined);
    }, [businessConfigStatus, capability, refreshBusinessConfig, source]);
    const options = useMemo(
        () => getModelPickerOptions(config, capability, serverModels, source, value),
        [capability, config, serverModels, source, value],
    );
    const current = boundModel?.modelId || resolveModelPickerValue(value, options, source);
    const emptyLabel = usesServerModels && businessConfigStatus !== "ready"
        ? businessConfigStatus === "error" ? uiText("模型配置加载失败") : uiText("正在加载模型…")
        : emptyModelLabel(config, capability, canManageConfig, source);
    const nameFor = (model: string) => {
        const serverModel = serverModels.find(item => item.modelId === model);
        return imageModelIdentityHidden(model, businessModels) ? imageModelDisplayName(model, businessModels)
            : serverModel?.name || modelOptionLabel(config, model);
    };
    const labelFor = (model: string) => modelLabelWithUsage(nameFor(model), serverModels.find(item => item.modelId === model)?.publicDescription);
    const currentLabel = binding?.enabled === false ? uiText("此板块已停用") : binding?.modelConfigId && !boundModel ? uiText("绑定模型不可用") : current ? `${labelFor(current)}${boundModel ? uiText(" · 后台指定") : ""}` : options.length ? placeholder : emptyLabel;

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const pickerDisabled = disabled || binding?.enabled === false || Boolean(binding?.modelConfigId);
    const changeOpen = (nextOpen: boolean) => {
        if (pickerDisabled && nextOpen) return;
        if (nextOpen) emitModelUsage("open");
        if (nextOpen && !options.length && source === "local" && canManageConfig) onMissingConfig?.();
        if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
        setOpen(nextOpen);
    };
    const changeValue = (model: string) => {
        if (!pickerDisabled && options.includes(model)) { onChange(model); emitModelUsage("change", serverModels.find(item => item.modelId === model)?.id); }
    };
    if (variant === "canvas" || (variant !== "default" && toolKey?.startsWith("canvas-"))) {
        const canvasOptions = options.map(model => {
            const serverModel = serverModels.find(item => item.modelId === model);
            const profile = capability === "image" ? imageModelProfile(model, businessModels) : undefined;
            return { value: model, ...canvasModelPresentation(nameFor(model)), description: serverModel?.publicDescription,
                details: profile ? canvasImageModelDetails(profile, referencePolicyForModel(model, profile)) : [], usageModelId: serverModel?.id,
                isFeatured: serverModel?.isFeatured === true, displayOrder: serverModel?.displayOrder };
        });
        const label = binding?.enabled === false ? uiText("此板块已停用") : binding?.modelConfigId && !boundModel ? uiText("绑定模型不可用")
            : canvasOptions.find(option => option.value === current)?.name || (options.length ? placeholder : emptyLabel);
        return <CanvasModelPicker options={canvasOptions} value={current} label={label} emptyLabel={emptyLabel} open={open} disabled={pickerDisabled} bound={Boolean(boundModel)}
            categoryLabel={uiText("{label}模型", { label: uiText(capability === "image" ? "图像" : modelCapabilityLabel(capability)) })} className={className} onOpenChange={changeOpen} onValueChange={changeValue} />;
    }

    return (
        <Select
            open={open}
            value={current}
            disabled={pickerDisabled}
            onOpenChange={changeOpen}
            onValueChange={changeValue}
        >
            <SelectTrigger
                data-usage-control="model"
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={currentLabel}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{currentLabel}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    options.map((model) => (
                        <SelectItem key={model} value={model} textValue={labelFor(model)} data-usage-control="model" data-usage-value={serverModels.find(item => item.modelId === model)?.id}>
                            <ModelLabel model={model} label={labelFor(model)} serverModel={serverModels.find((item)=>item.modelId===model)} />
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyLabel}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability, canManageConfig = false, source: ModelPickerSource = "local") {
    const label = uiText(modelCapabilityLabel(capability));
    if (source === "server") return uiText("暂无可用{label}模型{help}", { label, help: uiText(canManageConfig ? "，请在后台配置" : "，请联系管理员配置") });
    if (!canManageConfig) return uiText("暂无可用{label}模型，请联系管理员配置模型", { label });
    if (capability && config.models.length) return uiText("请先在上方配置可选模型");
    return config.models.length ? uiText("暂无匹配的{label}模型", { label }) : uiText("请先到配置里添加渠道和模型");
}

function ModelLabel({ model, label, serverModel }: { model: string; label: string; serverModel?: { creditCost: number } }) {
    useUiLocale();
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="flex min-w-0 flex-col py-1">
                <span className="whitespace-normal">{serverModel && deploymentFeatures.creditsEnabled ? uiText("{label} · 模型 {credits} 积分", { label, credits: serverModel.creditCost }) : label}</span>
            </span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    useUiLocale();
    const icon = imageModelIdentityHidden(model) ? "" : resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
