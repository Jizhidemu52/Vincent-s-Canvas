import { useUiText } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Select } from "antd";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { useAsyncAction } from "@/hooks/use-async-action";
import { getBusinessConfig, type PublicModel } from "@/services/api/business-config";
import { mergePromptEditorParameters, promptImageSettings } from "@/lib/prompt-editor-parameters";
import { imageModelProfile, imageModelSettingsError } from "@/lib/image-model-settings";
import { modelLabelWithUsage } from "@/lib/model-picker-options";
import { emitModelUsage } from "@/lib/usage-control-events";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { defaultConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

import { listServerAssets, type ServerAsset } from "@/services/api/server-assets";
import { promptTargetLabels, type PromptSnapshotInput, type PromptTargetTool, type PromptTemplate } from "@/services/api/prompts";

type FormValues = {
    title: string; prompt: string; targetTool: PromptTargetTool; modelConfigId?: string;
    size?: string; quality?: string; quantity?: number; imageOptions?: string; category?: string; tags?: string[];
    referenceAssetIds?: string[]; notes?: string;
};

export function PromptTemplateEditor({ open, initial, title, onCancel, onSubmit }: { open: boolean; initial?: PromptTemplate | null; title: string; onCancel: () => void; onSubmit: (input: PromptSnapshotInput) => Promise<void> }) {
    const t = useUiText();
    const [form] = Form.useForm<FormValues>();
    const [models, setModels] = useState<PublicModel[]>([]);
    const [assets, setAssets] = useState<ServerAsset[]>([]);
    const [assetCursor, setAssetCursor] = useState<string | null>(null);
    const [loadingMoreAssets, setLoadingMoreAssets] = useState(false);
    const { pending: saving, run } = useAsyncAction(`prompt-editor:${initial?.id || "new"}`);
    const [optionError, setOptionError] = useState("");
    const [optionsLoading, setOptionsLoading] = useState(false);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const targetTool = Form.useWatch("targetTool", form);
    const selectedModelId = Form.useWatch("modelConfigId", form);
    const selectedModel = models.find(model => model.id === selectedModelId);
    const imageProfile = targetTool !== "video" && selectedModel?.capabilities.some(capability => ["generate", "edit", "upscale"].includes(capability)) ? imageModelProfile(selectedModel.modelId, models) : undefined;
    const size = Form.useWatch("size", form);
    const quality = Form.useWatch("quality", form);
    const quantity = Form.useWatch("quantity", form);
    const imageOptions = Form.useWatch("imageOptions", form);
    const referenceAssetIds = Form.useWatch("referenceAssetIds", form);
    const updateImageSetting = useCallback((key: "size" | "quality" | "count" | "imageOptions", value: string) => {
        form.setFieldValue(key === "count" ? "quantity" : key, key === "count" ? Number(value) : value);
    }, [form]);

    useEffect(() => {
        if (!open) return;
        let active = true;
        const controller = new AbortController();
        setModels([]); setAssets([]); setOptionError(""); setOptionsLoading(true);
        setAssetCursor(null);
        void Promise.allSettled([getBusinessConfig(), listServerAssets({ kind: "image" }, controller.signal)]).then(([modelResult, assetResult]) => {
            if (!active) return;
            if (modelResult.status === "fulfilled") {
                setModels(modelResult.value.models);
                if (initial && initial.targetTool !== "video") {
                    const selected = modelResult.value.models.find(model => model.id === initial.modelConfigId);
                    if (selected?.capabilities.some(capability => ["generate", "edit", "upscale"].includes(capability))) {
                        const settings = promptImageSettings(initial.parameters, selected.modelId, modelResult.value.models);
                        form.setFieldsValue({ size: settings.size, quality: settings.quality, quantity: Number(settings.count), imageOptions: settings.imageOptions });
                    }
                }
            }
            if (assetResult.status === "fulfilled") { setAssets(assetResult.value.assets.filter((asset) => asset.kind === "image" && asset.status === "ready")); setAssetCursor(assetResult.value.nextCursor || null); }
            if (modelResult.status === "rejected" || assetResult.status === "rejected") setOptionError(t("模型或参考图选项加载失败，已有选择仍保留；可关闭后重新打开以重试。"));
            setOptionsLoading(false);
        });
        form.resetFields();
        form.setFieldsValue(initial ? {
            title: initial.title, prompt: initial.prompt, targetTool: initial.targetTool, modelConfigId: initial.modelConfigId ?? undefined,
            size: stringValue(initial.parameters.size), quality: stringValue(initial.parameters.quality), quantity: numberValue(initial.parameters.quantity) ?? numberValue(initial.parameters.count) ?? 1,
            imageOptions: typeof initial.parameters.imageOptions === "string" ? initial.parameters.imageOptions : "{}",
            category: initial.category, tags: initial.tags, referenceAssetIds: initial.referenceAssetIds, notes: initial.notes,
        } : { targetTool: "image-generation", quantity: 1, quality: "auto", imageOptions: "{}", tags: [], referenceAssetIds: [] });
        return () => { active = false; controller.abort(); };
    }, [form, initial, open]);

    const loadMoreAssets = async () => {
        if (!assetCursor || loadingMoreAssets) return;
        setLoadingMoreAssets(true);
        try {
            const page = await listServerAssets({ cursor: assetCursor, kind: "image" });
            setAssets(previous => [...previous, ...page.assets.filter(asset => asset.kind === "image" && asset.status === "ready" && !previous.some(item => item.id === asset.id))]);
            setAssetCursor(page.nextCursor || null);
        } catch (error) { setOptionError(error instanceof Error ? error.message : t("参考图加载失败")); }
        finally { setLoadingMoreAssets(false); }
    };

    const save = () => run(async () => {
        const values = await form.validateFields();
            const sizeError = imageProfile && values.size ? imageModelSettingsError(values.size, imageProfile) : "";
            if (sizeError) throw new Error(sizeError);
            await onSubmit({
                title: values.title, prompt: values.prompt, targetTool: values.targetTool, modelConfigId: values.modelConfigId ?? null,
                parameters: mergePromptEditorParameters(initial?.parameters, values, imageProfile),
                referenceAssetIds: values.referenceAssetIds || [], category: values.category || "", tags: values.tags || [], notes: values.notes || "",
                sourceTaskId: initial?.sourceTaskId, sourceAssetId: initial?.sourceAssetId,
            });
            form.resetFields();
    });

    return (
        <Modal title={title} open={open} onCancel={() => { if (!saving) onCancel(); }} onOk={() => void save()} okText={t("保存模板")} cancelText={t("取消")} okButtonProps={{ disabled: optionsLoading }} confirmLoading={saving} cancelButtonProps={{ disabled: saving }} closable={!saving} keyboard={!saving} maskClosable={!saving} width={760} destroyOnHidden>
            {optionError ? <Alert type="warning" showIcon message={optionError} /> : null}
            <Form form={form} layout="vertical" className="pt-3" disabled={saving || optionsLoading}>
                <div className="grid gap-x-4 md:grid-cols-2">
                    <Form.Item name="title" label={t("模板名称")} rules={[{ required: true, whitespace: true, max: 120 }]}><Input maxLength={120} showCount placeholder={t("例如：女装白底商品图")} /></Form.Item>
                    <Form.Item name="targetTool" label={t("适用板块")} rules={[{ required: true }]}><Select options={Object.entries(promptTargetLabels).map(([value, label]) => ({ value, label: t(label) }))} /></Form.Item>
                </div>
                <Form.Item name="prompt" label={t("完整提示词")} rules={[{ required: true, whitespace: true, max: 20_000 }]}><Input.TextArea rows={7} maxLength={20_000} showCount placeholder={t("保存可以直接复用的完整提示词")} /></Form.Item>
                <div className="grid gap-x-4 md:grid-cols-2">
                    <Form.Item name="modelConfigId" label={t("模型快照")}><Select allowClear showSearch optionFilterProp="label" placeholder={t("可不指定，由复用时选择")} onChange={value => emitModelUsage("change", value)} options={models.map((model) => ({ value: model.id, label: `${modelLabelWithUsage(model.name, model.publicDescription)}${deploymentFeatures.creditsEnabled ? t(" · {p0} 模型积分", { p0: String(model.creditCost) }) : ""}` }))} /></Form.Item>
                    <Form.Item name="referenceAssetIds" label={t("参考图")}><Select mode="multiple" allowClear maxTagCount="responsive" placeholder={t("从我的素材选择")} options={assets.map((asset) => ({ value: asset.id, label: asset.filename }))} /></Form.Item>
                </div>
                {assetCursor ? <Button className="mb-4" loading={loadingMoreAssets} disabled={saving} onClick={() => void loadMoreAssets()}>{t("加载更多参考图")}</Button> : null}
                <Form.Item name="imageOptions" hidden><Input /></Form.Item>
                <div className={imageProfile ? "hidden" : "grid gap-x-4 md:grid-cols-3"}>
                    <Form.Item name="size" label={t("尺寸/比例")}><Input maxLength={40} placeholder={t("例如 1:1 或 1024x1024")} /></Form.Item>
                    <Form.Item name="quality" label={t("质量")}><Select allowClear options={["auto", "high", "medium", "low"].map((value) => ({ value, label: value }))} /></Form.Item>
                    <Form.Item name="quantity" hidden><Input /></Form.Item>
                    <p className="text-xs opacity-65">{t("每次生成 1 张")}</p>
                </div>
                {imageProfile && selectedModel ? <fieldset disabled={saving || optionsLoading} className="mb-5 rounded-xl border border-[var(--border)] p-4">
                    <ImageSettingsPanel profile={imageProfile} referenceCount={referenceAssetIds?.length || 0} theme={theme} className="!w-full" config={{ ...defaultConfig, model: selectedModel.modelId, imageModel: selectedModel.modelId, size: size || "auto", quality: quality || "", count: String(quantity || 1), imageOptions: imageOptions || "{}" }} onConfigChange={updateImageSetting} />
                </fieldset> : null}
                <div className="grid gap-x-4 md:grid-cols-2">
                    <Form.Item name="category" label={t("个人分类")}><Input maxLength={80} placeholder={t("例如 商品图")} /></Form.Item>
                    <Form.Item name="tags" label={t("标签")}><Select mode="tags" maxCount={20} tokenSeparators={[",", "，"]} placeholder={t("输入后回车")} /></Form.Item>
                </div>
                <Form.Item name="notes" label={t("个人备注")}><Input.TextArea rows={3} maxLength={2_000} showCount placeholder={t("记录适用场景、注意事项或修改经验")} /></Form.Item>
            </Form>
        </Modal>
    );
}

function stringValue(value: unknown) { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
