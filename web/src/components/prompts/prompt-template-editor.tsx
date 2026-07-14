import { useEffect, useState } from "react";
import { Form, Input, InputNumber, Modal, Select } from "antd";

import { listServerAssets, type ServerAsset } from "@/services/api/server-assets";
import { promptTargetLabels, type PromptSnapshotInput, type PromptTargetTool, type PromptTemplate } from "@/services/api/prompts";

type ModelOption = { id: string; name: string; modelId: string; capabilities: string[]; creditCost: number };
type FormValues = {
    title: string; prompt: string; targetTool: PromptTargetTool; modelConfigId?: string;
    size?: string; quality?: string; quantity?: number; category?: string; tags?: string[];
    referenceAssetIds?: string[]; notes?: string;
};

export function PromptTemplateEditor({ open, initial, title, onCancel, onSubmit }: { open: boolean; initial?: PromptTemplate | null; title: string; onCancel: () => void; onSubmit: (input: PromptSnapshotInput) => Promise<void> }) {
    const [form] = Form.useForm<FormValues>();
    const [models, setModels] = useState<ModelOption[]>([]);
    const [assets, setAssets] = useState<ServerAsset[]>([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        void Promise.all([
            fetch("/api/models", { credentials: "include" }).then((response) => response.ok ? response.json() : Promise.reject()).then((data: { models: ModelOption[] }) => setModels(data.models)),
            listServerAssets().then((data) => setAssets(data.assets.filter((asset) => asset.kind === "image" && asset.status === "ready"))),
        ]).catch(() => undefined);
        form.setFieldsValue(initial ? {
            title: initial.title, prompt: initial.prompt, targetTool: initial.targetTool, modelConfigId: initial.modelConfigId ?? undefined,
            size: stringValue(initial.parameters.size), quality: stringValue(initial.parameters.quality), quantity: numberValue(initial.parameters.quantity) ?? numberValue(initial.parameters.count) ?? 1,
            category: initial.category, tags: initial.tags, referenceAssetIds: initial.referenceAssetIds, notes: initial.notes,
        } : { targetTool: "image-generation", quantity: 1, quality: "auto", tags: [], referenceAssetIds: [] });
    }, [form, initial, open]);

    const save = async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            await onSubmit({
                title: values.title, prompt: values.prompt, targetTool: values.targetTool, modelConfigId: values.modelConfigId ?? null,
                parameters: { size: values.size || undefined, quality: values.quality || undefined, quantity: values.quantity || 1 },
                referenceAssetIds: values.referenceAssetIds || [], category: values.category || "", tags: values.tags || [], notes: values.notes || "",
                sourceTaskId: initial?.sourceTaskId, sourceAssetId: initial?.sourceAssetId,
            });
            form.resetFields();
        } finally { setSaving(false); }
    };

    return (
        <Modal title={title} open={open} onCancel={onCancel} onOk={() => void save()} okText="保存模板" cancelText="取消" confirmLoading={saving} width={760} destroyOnHidden>
            <Form form={form} layout="vertical" className="pt-3">
                <div className="grid gap-x-4 md:grid-cols-2">
                    <Form.Item name="title" label="模板名称" rules={[{ required: true, whitespace: true, max: 120 }]}><Input maxLength={120} showCount placeholder="例如：女装白底商品图" /></Form.Item>
                    <Form.Item name="targetTool" label="适用板块" rules={[{ required: true }]}><Select options={Object.entries(promptTargetLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
                </div>
                <Form.Item name="prompt" label="完整提示词" rules={[{ required: true, whitespace: true, max: 20_000 }]}><Input.TextArea rows={7} maxLength={20_000} showCount placeholder="保存可以直接复用的完整提示词" /></Form.Item>
                <div className="grid gap-x-4 md:grid-cols-2">
                    <Form.Item name="modelConfigId" label="模型快照"><Select allowClear showSearch optionFilterProp="label" placeholder="可不指定，由复用时选择" options={models.map((model) => ({ value: model.id, label: `${model.name} · ${model.creditCost} 模型积分` }))} /></Form.Item>
                    <Form.Item name="referenceAssetIds" label="参考图"><Select mode="multiple" allowClear maxTagCount="responsive" placeholder="从我的素材选择" options={assets.map((asset) => ({ value: asset.id, label: asset.filename }))} /></Form.Item>
                </div>
                <div className="grid gap-x-4 md:grid-cols-3">
                    <Form.Item name="size" label="尺寸/比例"><Input maxLength={40} placeholder="例如 1:1 或 1024x1024" /></Form.Item>
                    <Form.Item name="quality" label="质量"><Select allowClear options={["auto", "high", "medium", "low"].map((value) => ({ value, label: value }))} /></Form.Item>
                    <Form.Item name="quantity" label="生成数量"><InputNumber className="w-full" min={1} max={100} precision={0} /></Form.Item>
                </div>
                <div className="grid gap-x-4 md:grid-cols-2">
                    <Form.Item name="category" label="个人分类"><Input maxLength={80} placeholder="例如 商品图" /></Form.Item>
                    <Form.Item name="tags" label="标签"><Select mode="tags" maxCount={20} tokenSeparators={[",", "，"]} placeholder="输入后回车" /></Form.Item>
                </div>
                <Form.Item name="notes" label="个人备注"><Input.TextArea rows={3} maxLength={2_000} showCount placeholder="记录适用场景、注意事项或修改经验" /></Form.Item>
            </Form>
        </Modal>
    );
}

function stringValue(value: unknown) { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
