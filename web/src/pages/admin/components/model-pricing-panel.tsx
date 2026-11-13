import { displayNotice, useDisplayConfig  } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { App, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tag } from "antd";
import { useEffect, useState } from "react";
import { getApimartImageCost } from "../../../../../shared/apimart-image-costs";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { adminLabel } from "../admin-labels";
import {
    createServerModel, listServerModels, listServerProviders, listServerWorkflows, updateServerModel,
    type ServerModel, type ServerProvider, type ServerWorkflow,
} from "@/services/api/model-configuration";

const capabilityOptions = ["generate", "edit", "upscale", "remove_background", "batch", "chat", "vision", "tools", "video", "audio"].map((value) => ({ value, label: adminLabel(value) }));
type ModelValues = Omit<ServerModel, "id" | "providerName" | "workflowName" | "imageCost" | "creditCost" | "rmbCost">;

export function ModelPricingPanel({ mode }: { mode: "prices" | "models" }) {
    return mode === "models" ? <ModelConfigurationPanel /> : null;
}

export function ModelConfigurationPanel() {
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const { message } = App.useApp();
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const { confirmDiscard } = useUnsavedGuard(dirty, staticUiText("模型配置尚未保存，离开后将丢失本次修改。"));
    const [modelForm] = Form.useForm<ModelValues>();
    const [providers, setProviders] = useState<ServerProvider[]>([]);
    const [models, setModels] = useState<ServerModel[]>([]);
    const [workflows, setWorkflows] = useState<ServerWorkflow[]>([]);
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const editingModel = models.find(model => model.id === editingModelId);

    const refresh = async () => {
        setLoading(true);
        try {
            const [providerResult, modelResult, workflowResult] = await Promise.all([listServerProviders(), listServerModels(), listServerWorkflows()]);
            setProviders(providerResult.providers);
            setModels(modelResult.models);
            setWorkflows(workflowResult.workflows);
        } catch (error) {
            message.error(displayNotice(error instanceof Error ? error.message : staticUiText("配置加载失败")));
        } finally { setLoading(false); }
    };
    useEffect(() => { void refresh(); }, []);

    const saveModel = async (values: ModelValues) => {
        if (saving) return;
        setSaving(true);
        try {
            // Removed controls must not reset the loaded record, including explicit zero.
            // New records retain the previous form defaults and fixed image-model default.
            const input = {
                ...values,
                creditCost: editingModel ? editingModel.creditCost : 4,
                rmbCost: editingModel ? editingModel.rmbCost : getApimartImageCost(values.providerId, values.modelId)?.rmbPerImage ?? 0.4,
            };
            if (editingModelId) await updateServerModel(editingModelId, input);
            else await createServerModel(input);
            message.success(staticUiText("模型配置已保存到服务端"));
            setEditingModelId(null);
            modelForm.resetFields();
            setDirty(false);
            await refresh();
        } catch (error) {
            message.error(displayNotice(error instanceof Error ? error.message : staticUiText("模型保存失败")));
        } finally { setSaving(false); }
    };
    const editModel = async (model: ServerModel) => {
        if (!await confirmDiscard()) return;
        setDirty(false);
        setEditingModelId(model.id);
        modelForm.setFieldsValue({
            providerId: model.providerId,
            workflowConfigId: model.workflowConfigId,
            replacementModelConfigId: model.replacementModelConfigId ?? null,
            name: model.name,
            modelId: model.modelId,
            capabilities: model.capabilities,
            concurrencyLimit: model.concurrencyLimit,
            enabled: model.enabled,
        });
    };

    return (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Table className="min-w-0" rowKey="id" size="small" scroll={{ x: 1000 }} loading={loading} dataSource={models} columns={displayConfig([
                { title: staticUiText("模型名称"), dataIndex: "name" },
                { title: staticUiText("设计师端名称"), dataIndex: "publicName", render: (value: string | undefined) => value || "—" },
                { title: staticUiText("模型 ID"), dataIndex: "modelId" },
                { title: "Provider", dataIndex: "providerName" },
                { title: staticUiText("工作流"), dataIndex: "workflowName" },
                { title: staticUiText("能力"), render: (_, record: ServerModel) => <Space wrap>{record.capabilities.map(item => <Tag key={item}>{adminLabel(item)}</Tag>)}</Space> },
                { title: staticUiText("并发"), dataIndex: "concurrencyLimit" },
                { title: staticUiText("状态"), render: (_, record: ServerModel) => <Tag color={record.enabled ? "green" : "red"}>{record.enabled ? staticUiText("启用") : staticUiText("停用")}</Tag> },
                { title: staticUiText("操作"), render: (_, record: ServerModel) => <Button size="small" onClick={() => editModel(record)}>{staticUiText("编辑")}</Button> },
            ], "columns", models)} />
            <section className="wb-surface min-w-0 p-5">
                <h3 className="mb-4 text-base font-semibold">{editingModelId ? staticUiText("编辑模型") : staticUiText("新增模型")}</h3>
                <Form form={modelForm} layout="vertical" disabled={saving} onValuesChange={() => setDirty(true)} initialValues={{ capabilities: ["generate"], concurrencyLimit: 5, enabled: true }} onFinish={saveModel}>
                    <Form.Item name="providerId" label="Provider" rules={[{ required: true }]}><Select options={displayConfig(providers.map(item => ({ label: item.name, value: item.id })), "options")} /></Form.Item>
                    <Form.Item name="workflowConfigId" label={staticUiText("工作流（可选）")}><Select allowClear options={displayConfig(workflows.map(item => ({ label: item.name + " · " + item.protocol, value: item.id })), "options")} /></Form.Item>
                    <Form.Item name="replacementModelConfigId" label={staticUiText("停用后的替代模型")}><Select allowClear placeholder={staticUiText("不自动替代，由设计师选择")} options={displayConfig(models.filter(item => item.id !== editingModelId).map(item => ({ label: item.name + " · " + item.modelId, value: item.id })), "options")} /></Form.Item>
                    <Form.Item name="name" label={staticUiText("管理员模型名称")} extra={staticUiText("图片模型在设计师端使用用途名称；这里保留真实名称。")} rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name="modelId" label={staticUiText("模型 ID")} rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name="capabilities" label={staticUiText("支持能力")} rules={[{ required: true }]}><Select mode="multiple" options={displayConfig(capabilityOptions, "options")} /></Form.Item>
                    <Form.Item name="concurrencyLimit" label={staticUiText("并发")}><InputNumber className="w-full" min={1} max={100} /></Form.Item>
                    <Form.Item name="enabled" label={staticUiText("启用")} valuePropName="checked"><Switch /></Form.Item>
                    <Button className="!h-10" type="primary" htmlType="submit" block>{staticUiText("保存到服务端")}</Button>
                </Form>
            </section>
        </div>
    );
}
