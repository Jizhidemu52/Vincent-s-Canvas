import { Alert, App, Button, Empty, Form, Input, Select, Skeleton } from "antd";
import { useEffect, useState } from "react";
import { imageOptionLabel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { imageModelProfile } from "@/lib/image-model-settings";
import { imageOptionFields } from "@/lib/image-advanced-settings";
import { getImageDefaults, saveImageDefaults, type ImageDefaultsConfiguration } from "@/services/api/model-configuration";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";

export function ImageGenerationDefaultsPanel() {
    const { message } = App.useApp();
    const [saved, setSaved] = useState<ImageDefaultsConfiguration>();
    const [defaultId, setDefaultId] = useState<string | null>(null);
    const [editId, setEditId] = useState("");
    const [options, setOptions] = useState<ImageDefaultsConfiguration["modelOptions"][string]>({});
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const [saving, setSaving] = useState(false);
    const savedOptions = saved?.modelOptions[editId] ?? {};
    const fields = new Set([...Object.keys(savedOptions), ...Object.keys(options)] as Array<keyof typeof options>);
    const paramsDirty = [...fields].some(key => savedOptions[key] !== options[key]);
    const dirty = !!saved && (defaultId !== saved.defaultModelConfigId || paramsDirty);
    const { confirmDiscard } = useUnsavedGuard(dirty, "默认图片配置尚未保存。");
    useEffect(() => {
        const controller = new AbortController();
        setError("");
        getImageDefaults(controller.signal).then(config => {
            if (controller.signal.aborted) return;
            const id = config.effectiveModelConfigId ?? config.models[0]?.id ?? "";
            setSaved(config);
            setDefaultId(config.defaultModelConfigId);
            setEditId(id);
            setOptions(config.modelOptions[id] ?? {});
        }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
        return () => controller.abort();
    }, [attempt]);
    if (error) return <Alert type="error" showIcon title={error} action={<Button onClick={() => setAttempt(n => n + 1)}>重试</Button>} />;
    if (!saved) return <Skeleton active />;
    const model = saved.models.find(item => item.id === editId);
    if (!model) return <Empty description="请先启用支持文生图和图生图的图片模型" />;
    const profile = imageModelProfile(model.id, saved.models, "super_admin");
    const models = saved.models.map(item => ({ value: item.id, label: item.name }));
    const systemDefault = saved.models.find(item => item.id === saved.systemDefaultModelConfigId);
    const resolutions = profile.resolutions.length ? profile.resolutions : profile.qualities.filter(value => /^([0-9.]+)k$/.test(value));
    const settings: Array<{ key: keyof typeof options; label: string; choices: string[]; display: (value: string) => string }> = [
        { key: "background", label: "背景", choices: profile.backgrounds, display: imageOptionLabel },
        { key: "size", label: "尺寸", choices: profile.sizes, display: imageSizeLabel },
        { key: "resolution", label: "分辨率", choices: resolutions, display: (value: string) => value.toUpperCase() },
        { key: "quality", label: "画质", choices: profile.qualities.length > 1 ? profile.qualities.filter(value => ["auto", "low", "medium", "high", "xhigh", "max"].includes(value)) : [], display: imageQualityLabel },
    ];
    for (const field of imageOptionFields(profile)) {
        if (["complexity", "moderation", "output_format"].includes(field.key) && field.options) {
            settings.push({ key: field.key as keyof typeof options, label: field.label, choices: field.options.filter(value => value !== "gif"), display: imageOptionLabel });
        } else if (field.type === "boolean" && ["nsfw_check", "official_fallback", "web_grounding", "google_search", "google_image_search"].includes(field.key)) {
            settings.push({ key: field.key as keyof typeof options, label: field.label, choices: ["true", "false"], display: imageOptionLabel });
        }
    }
    const editModel = async (id: string) => {
        if (paramsDirty && !(await confirmDiscard())) return false;
        setEditId(id);
        setOptions(saved.modelOptions[id] ?? {});
        return true;
    };
    const save = async () => {
        setSaving(true);
        try {
            const config = await saveImageDefaults(defaultId !== saved.defaultModelConfigId ? defaultId : undefined, editId, paramsDirty ? options : undefined);
            setSaved(config);
            setDefaultId(config.defaultModelConfigId);
            setOptions(config.modelOptions[editId] ?? {});
            message.success("已保存默认图片配置");
            void useBusinessConfigStore.getState().refresh({ background: true }).catch(() => {});
        } catch (reason) { message.error(reason instanceof Error ? reason.message : "保存失败"); }
        finally { setSaving(false); }
    };
    return <section className="wb-surface max-w-3xl p-5">
        <Form layout="vertical" disabled={saving}>
            <Form.Item label="全局默认图片模型" extra="新建任务时使用。已单独绑定模型的板块优先使用绑定模型。">
                <Select aria-label="全局默认图片模型" value={defaultId ?? ""} options={[{ value: "", label: systemDefault ? `跟随系统默认（${systemDefault.name}）` : "跟随系统默认" }, ...models]}
                    onChange={async (id: string) => {
                        const target = id || systemDefault?.id;
                        if (target && target !== editId && !await editModel(target)) return;
                        setDefaultId(id || null);
                    }} />
            </Form.Item>
            <Form.Item label="编辑模型的默认参数" extra="使用该模型的板块共用这组默认值。设计师可在单次任务中更改。">
                <Select aria-label="编辑模型的默认参数" value={editId} options={models} onChange={editModel} />
            </Form.Item>
            <div className="grid gap-x-4 sm:grid-cols-2">
                {settings.filter(field => field.choices.length).map(field => <Form.Item key={field.key} label={field.label}>
                    <Select aria-label={field.label} value={String(options[field.key] ?? "")} onChange={(value: string) => setOptions(current => ({ ...current, [field.key]: value === "true" ? true : value === "false" ? false : value || undefined }))}
                        options={[{ value: "", label: field.key === "background" && model.imageDefaultBackground ? `模型默认（${imageOptionLabel(model.imageDefaultBackground)}）` : "沿用模型默认" },
                            ...field.choices.map(value => ({ value, label: field.display(value) }))]} />
                </Form.Item>)}
            </div>
            {profile.kind === "qwen-image" ? <Form.Item label="排除内容">
                <Input.TextArea aria-label="排除内容" maxLength={2000} value={options.negative_prompt ?? ""} onChange={event => setOptions({ ...options, negative_prompt: event.target.value || undefined })} />
            </Form.Item> : null}
            <Button type="primary" disabled={!dirty} loading={saving} onClick={save}>保存默认配置</Button>
        </Form>
    </section>;
}
