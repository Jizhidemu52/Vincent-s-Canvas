import { App, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tag } from "antd";
import { useEffect, useState } from "react";
import { getApimartImageCost } from "../../../../../shared/apimart-image-costs";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { adminLabel } from "../admin-labels";

import {
    createPriceDraft,
    createServerModel,
    listPriceVersions,
    listServerModels,
    listServerProviders,
    listServerWorkflows,
    markPriceTesting,
    publishPrice,
    updateServerModel,
    type PriceVersion,
    type ServerModel,
    type ServerProvider,
    type ServerWorkflow,
} from "@/services/api/model-configuration";

const operationOptions = [
    ["image_generation", "生成一张图"],
    ["upscale", "放大图片"],
    ["remove_background", "去背景"],
    ["video_generation", "生成视频"],
    ["audio_generation", "生成音频"],
    ["inpaint", "局部编辑"],
    ["batch_image", "批量处理每张图"],
    ["seamless_stitch", "无缝拼接"],
].map(([value, label]) => ({ value, label }));
const capabilityOptions = ["generate", "edit", "upscale", "remove_background", "batch", "chat", "video", "audio"].map((value) => ({ value, label: adminLabel(value) }));

type PriceValues = { operationType: string; label: string; credits: number; rmbCost: number };
type ModelValues = Omit<ServerModel, "id" | "providerName" | "workflowName" | "imageCost">;

export function ModelPricingPanel({ mode }: { mode: "prices" | "models" }) {
    const { message, modal } = App.useApp();
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const { confirmDiscard } = useUnsavedGuard(dirty, "价格或模型配置尚未保存，离开后将丢失本次修改。");
    const [priceForm] = Form.useForm<PriceValues>();
    const [modelForm] = Form.useForm<ModelValues>();
    const [providers, setProviders] = useState<ServerProvider[]>([]);
    const [prices, setPrices] = useState<PriceVersion[]>([]);
    const [models, setModels] = useState<ServerModel[]>([]);
    const [workflows, setWorkflows] = useState<ServerWorkflow[]>([]);
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const formProviderId = Form.useWatch("providerId", modelForm);
    const formModelId = Form.useWatch("modelId", modelForm);
    const editingModel = models.find(model => model.id === editingModelId);
    const imageCost = getApimartImageCost(formProviderId, formModelId)
        ?? (editingModel?.providerId === formProviderId && editingModel?.modelId === formModelId ? editingModel?.imageCost : null);

    useEffect(() => {
        if (imageCost) modelForm.setFieldValue("rmbCost", imageCost.rmbPerImage);
    }, [imageCost?.rmbPerImage, modelForm]);

    const refresh = async () => {
        setLoading(true);
        try {
            const [providerResult, priceResult, modelResult, workflowResult] = await Promise.all([listServerProviders(), listPriceVersions(), listServerModels(), listServerWorkflows()]);
            setProviders(providerResult.providers);
            setPrices(priceResult.prices);
            setModels(modelResult.models);
            setWorkflows(workflowResult.workflows);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "配置加载失败");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void refresh();
    }, []);

    const savePrice = async (values: PriceValues) => {
        if (saving) return;
        setSaving(true);
        try {
            await createPriceDraft(values);
            message.success("价格草稿已创建，测试或发布前不会影响设计师");
            priceForm.resetFields();
            setDirty(false);
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "价格草稿保存失败");
        } finally { setSaving(false); }
    };
    const changePriceStatus = async (price: PriceVersion, action: "test" | "publish") => {
        if (action === "publish" && !await modal.confirm({ title: `确认发布“${price.label}”价格？`, content: `版本 ${price.version}：${price.credits} 积分，人民币成本 ￥${price.rmbCost.toFixed(6)}。发布后将影响所有使用该操作价格的新任务；不会改写历史任务费用。`, okText: "确认发布价格", cancelText: "暂不发布", okButtonProps: { danger: true } })) return;
        if (saving) return;
        setSaving(true);
        try {
            if (action === "test") await markPriceTesting(price.id);
            else await publishPrice(price.id);
            message.success(action === "test" ? "已进入测试" : "价格已发布");
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "价格状态更新失败");
        } finally { setSaving(false); }
    };
    const saveModel = async (values: ModelValues) => {
        if (saving) return;
        setSaving(true);
        try {
            const fixedCost = getApimartImageCost(values.providerId, values.modelId)
                ?? (editingModel?.providerId === values.providerId && editingModel?.modelId === values.modelId ? editingModel?.imageCost : null);
            const input = { ...values, rmbCost: fixedCost?.rmbPerImage ?? values.rmbCost };
            if (editingModelId) await updateServerModel(editingModelId, input);
            else await createServerModel(input);
            message.success("模型配置已保存到服务端");
            setEditingModelId(null);
            modelForm.resetFields();
            setDirty(false);
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型保存失败");
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
            creditCost: model.creditCost,
            rmbCost: model.imageCost?.rmbPerImage ?? getApimartImageCost(model.providerId, model.modelId)?.rmbPerImage ?? model.rmbCost,
            concurrencyLimit: model.concurrencyLimit,
            enabled: model.enabled,
        });
    };

    if (mode === "prices")
        return (
            <div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1fr)_360px]">
                <Table
                    className="min-w-0"
                    scroll={{ x: 680 }}
                    rowKey="id"
                    size="small"
                    loading={loading}
                    dataSource={prices}
                    columns={[
                        { title: "操作", dataIndex: "label" },
                        { title: "版本", dataIndex: "version" },
                        { title: "积分", dataIndex: "credits" },
                        { title: "人民币成本", render: (_, record: PriceVersion) => `￥${record.rmbCost.toFixed(6)}` },
                        { title: "状态", render: (_, record: PriceVersion) => <Tag color={record.status === "published" ? "green" : record.status === "testing" ? "orange" : "default"}>{adminLabel(record.status)}</Tag> },
                        {
                            title: "操作",
                            render: (_, record: PriceVersion) => (
                                <Space>
                                    {record.status === "draft" ? (
                                        <Button size="small" disabled={saving} onClick={() => changePriceStatus(record, "test")}>
                                            测试
                                        </Button>
                                    ) : null}
                                    {record.status === "draft" || record.status === "testing" ? (
                                        <Button size="small" type="primary" disabled={saving} onClick={() => changePriceStatus(record, "publish")}>
                                            发布
                                        </Button>
                                    ) : null}
                                </Space>
                            ),
                        },
                    ]}
                />
                <section className="wb-surface p-5">
                    <h3 className="mb-4 text-base font-semibold">创建价格草稿</h3>
                    <Form form={priceForm} layout="vertical" disabled={saving} onValuesChange={() => setDirty(true)} initialValues={{ operationType: "image_generation", label: "生成一张图", credits: 8, rmbCost: 0.8 }} onFinish={savePrice}>
                        <Form.Item name="operationType" label="操作类型" rules={[{ required: true }]}>
                            <Select options={operationOptions} />
                        </Form.Item>
                        <Form.Item name="label" label="显示名称" rules={[{ required: true }]}>
                            <Input />
                        </Form.Item>
                        <Form.Item name="credits" label="积分" rules={[{ required: true }]}>
                            <InputNumber className="w-full" min={0} />
                        </Form.Item>
                        <Form.Item name="rmbCost" label="人民币成本" rules={[{ required: true }]}>
                            <InputNumber className="w-full" min={0} precision={6} />
                        </Form.Item>
                        <Button className="!h-10" type="primary" htmlType="submit" block>
                            保存草稿
                        </Button>
                    </Form>
                </section>
            </div>
        );

    return (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Table
                className="min-w-0"
                rowKey="id"
                size="small"
                scroll={{ x: 1280 }}
                loading={loading}
                dataSource={models}
                columns={[
                    { title: "模型名称", dataIndex: "name" },
                    { title: "设计师端名称", dataIndex: "publicName", render: (value: string | undefined) => value || "—" },
                    { title: "模型 ID", dataIndex: "modelId" },
                    { title: "Provider", dataIndex: "providerName" },
                    { title: "工作流", dataIndex: "workflowName" },
                    {
                        title: "能力",
                        render: (_, record: ServerModel) => (
                            <Space wrap>
                                {record.capabilities.map((item) => (
                                    <Tag key={item}>{adminLabel(item)}</Tag>
                                ))}
                            </Space>
                        ),
                    },
                    { title: "积分", dataIndex: "creditCost" },
                    { title: "人民币成本", render: (_, model: ServerModel) => `￥${(model.imageCost?.rmbPerImage ?? getApimartImageCost(model.providerId, model.modelId)?.rmbPerImage ?? model.rmbCost).toFixed(6)}${model.imageCost || getApimartImageCost(model.providerId, model.modelId) ? " / 张" : ""}` },
                    { title: "并发", dataIndex: "concurrencyLimit" },
                    { title: "状态", render: (_, record: ServerModel) => <Tag color={record.enabled ? "green" : "red"}>{record.enabled ? "启用" : "停用"}</Tag> },
                    {
                        title: "操作",
                        render: (_, record: ServerModel) => (
                            <Button size="small" onClick={() => editModel(record)}>
                                编辑
                            </Button>
                        ),
                    },
                ]}
            />
            <section className="wb-surface min-w-0 p-5">
                <h3 className="mb-4 text-base font-semibold">{editingModelId ? "编辑模型" : "新增模型"}</h3>
                <Form form={modelForm} layout="vertical" disabled={saving} onValuesChange={() => setDirty(true)} initialValues={{ capabilities: ["generate"], creditCost: 4, rmbCost: 0.4, concurrencyLimit: 5, enabled: true }} onFinish={saveModel}>
                    <Form.Item name="providerId" label="Provider" rules={[{ required: true }]}>
                        <Select options={providers.map((item) => ({ label: item.name, value: item.id }))} />
                    </Form.Item>
                    <Form.Item name="workflowConfigId" label="工作流（可选）">
                        <Select allowClear options={workflows.map((item) => ({ label: `${item.name} · ${item.protocol}`, value: item.id }))} />
                    </Form.Item>
                    <Form.Item name="replacementModelConfigId" label="停用后的替代模型">
                        <Select allowClear placeholder="不自动替代，由设计师选择" options={models.filter((item) => item.id !== editingModelId).map((item) => ({ label: `${item.name} · ${item.modelId}`, value: item.id }))} />
                    </Form.Item>
                    <Form.Item name="name" label="管理员模型名称" extra="图片模型在设计师端使用用途名称；这里保留真实名称。" rules={[{ required: true }]}>
                        <Input />
                    </Form.Item>
                    <Form.Item name="modelId" label="模型 ID" rules={[{ required: true }]}>
                        <Input />
                    </Form.Item>
                    <Form.Item name="capabilities" label="支持能力" rules={[{ required: true }]}>
                        <Select mode="multiple" options={capabilityOptions} />
                    </Form.Item>
                    {imageCost ? <p className="mb-3 text-xs text-[var(--muted-foreground)]">固定人民币单价 ￥{imageCost.rmbPerImage.toFixed(6)} / 张，按成功出图张数统计；不叠加操作费，也不受板块人民币成本覆盖影响。站内积分单独配置。</p> : null}
                    <div className="grid grid-cols-3 gap-2">
                        <Form.Item name="creditCost" label="积分">
                            <InputNumber className="w-full" min={0} />
                        </Form.Item>
                        <Form.Item name="rmbCost" label={imageCost ? "人民币 / 张" : "成本 / 元"}>
                            <InputNumber className="w-full" min={0} precision={6} readOnly={Boolean(imageCost)} controls={!imageCost} />
                        </Form.Item>
                        <Form.Item name="concurrencyLimit" label="并发">
                            <InputNumber className="w-full" min={1} max={100} />
                        </Form.Item>
                    </div>
                    <Form.Item name="enabled" label="启用" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    <Button className="!h-10" type="primary" htmlType="submit" block>
                        保存到服务端
                    </Button>
                </Form>
            </section>
        </div>
    );
}
