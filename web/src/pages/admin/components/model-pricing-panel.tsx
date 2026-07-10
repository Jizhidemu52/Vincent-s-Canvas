import { App, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tag } from "antd";
import { useEffect, useState } from "react";

import { createPriceDraft, createServerModel, listPriceVersions, listServerModels, listServerProviders, listServerWorkflows, markPriceTesting, publishPrice, updateServerModel, type PriceVersion, type ServerModel, type ServerProvider, type ServerWorkflow } from "@/services/api/model-configuration";

const operationOptions = [
    ["image_generation", "生成一张图"], ["upscale", "放大图片"], ["remove_background", "去背景"],
    ["video_generation","生成视频"],
    ["inpaint", "局部编辑"], ["batch_image", "批量处理每张图"], ["seamless_stitch", "无缝拼接"],
].map(([value, label]) => ({ value, label }));
const capabilityOptions = ["generate", "edit", "upscale", "remove_background", "batch","chat","video","audio"].map((value) => ({ value, label: value }));

type PriceValues = { operationType: string; label: string; credits: number; rmbCost: number };
type ModelValues = Omit<ServerModel, "id" | "providerName" | "workflowName">;

export function ModelPricingPanel({ mode }: { mode: "prices" | "models" }) {
    const { message } = App.useApp();
    const [priceForm] = Form.useForm<PriceValues>();
    const [modelForm] = Form.useForm<ModelValues>();
    const [providers, setProviders] = useState<ServerProvider[]>([]);
    const [prices, setPrices] = useState<PriceVersion[]>([]);
    const [models, setModels] = useState<ServerModel[]>([]);
    const [workflows,setWorkflows]=useState<ServerWorkflow[]>([]);
    const [editingModelId, setEditingModelId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = async () => {
        setLoading(true);
        try {
            const [providerResult, priceResult, modelResult,workflowResult] = await Promise.all([listServerProviders(), listPriceVersions(), listServerModels(),listServerWorkflows()]);
            setProviders(providerResult.providers); setPrices(priceResult.prices); setModels(modelResult.models);setWorkflows(workflowResult.workflows);
        } catch (error) { message.error(error instanceof Error ? error.message : "配置加载失败"); }
        finally { setLoading(false); }
    };
    useEffect(() => { void refresh(); }, []);

    const savePrice = async (values: PriceValues) => {
        try { await createPriceDraft(values); message.success("价格草稿已创建，测试或发布前不会影响设计师"); priceForm.resetFields(); await refresh(); }
        catch (error) { message.error(error instanceof Error ? error.message : "价格草稿保存失败"); }
    };
    const changePriceStatus = async (price: PriceVersion, action: "test" | "publish") => {
        try { if (action === "test") await markPriceTesting(price.id); else await publishPrice(price.id); message.success(action === "test" ? "已进入测试" : "价格已发布"); await refresh(); }
        catch (error) { message.error(error instanceof Error ? error.message : "价格状态更新失败"); }
    };
    const saveModel = async (values: ModelValues) => {
        try {
            if (editingModelId) await updateServerModel(editingModelId, values); else await createServerModel(values);
            message.success("模型配置已保存到服务端"); setEditingModelId(null); modelForm.resetFields(); await refresh();
        } catch (error) { message.error(error instanceof Error ? error.message : "模型保存失败"); }
    };
    const editModel = (model: ServerModel) => { setEditingModelId(model.id); modelForm.setFieldsValue({ providerId: model.providerId,workflowConfigId:model.workflowConfigId, name: model.name, modelId: model.modelId, capabilities: model.capabilities, creditCost: model.creditCost, rmbCost: model.rmbCost, concurrencyLimit: model.concurrencyLimit, enabled: model.enabled }); };

    if (mode === "prices") return (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Table rowKey="id" size="small" loading={loading} dataSource={prices} columns={[
                { title: "操作", dataIndex: "label" }, { title: "版本", dataIndex: "version" }, { title: "积分", dataIndex: "credits" },
                { title: "人民币成本", render: (_, record: PriceVersion) => `￥${record.rmbCost.toFixed(4)}` },
                { title: "状态", render: (_, record: PriceVersion) => <Tag color={record.status === "published" ? "green" : record.status === "testing" ? "orange" : "default"}>{record.status}</Tag> },
                { title: "操作", render: (_, record: PriceVersion) => <Space>{record.status === "draft" ? <Button size="small" onClick={() => changePriceStatus(record, "test")}>测试</Button> : null}{record.status === "draft" || record.status === "testing" ? <Button size="small" type="primary" onClick={() => changePriceStatus(record, "publish")}>发布</Button> : null}</Space> },
            ]} />
            <section className="rounded-md border border-stone-200 bg-white p-4">
                <h3 className="mb-4 text-base font-semibold">创建价格草稿</h3>
                <Form form={priceForm} layout="vertical" initialValues={{ operationType: "image_generation", label: "生成一张图", credits: 8, rmbCost: 0.8 }} onFinish={savePrice}>
                    <Form.Item name="operationType" label="操作类型" rules={[{ required: true }]}><Select options={operationOptions} /></Form.Item>
                    <Form.Item name="label" label="显示名称" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name="credits" label="积分" rules={[{ required: true }]}><InputNumber className="w-full" min={0} /></Form.Item>
                    <Form.Item name="rmbCost" label="人民币成本" rules={[{ required: true }]}><InputNumber className="w-full" min={0} precision={4} /></Form.Item>
                    <Button type="primary" htmlType="submit" block>保存草稿</Button>
                </Form>
            </section>
        </div>
    );

    return (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Table rowKey="id" size="small" loading={loading} dataSource={models} columns={[
                { title: "模型名称", dataIndex: "name" }, { title: "模型 ID", dataIndex: "modelId" }, { title: "Provider", dataIndex: "providerName" },{title:"工作流",dataIndex:"workflowName"},
                { title: "能力", render: (_, record: ServerModel) => <Space wrap>{record.capabilities.map((item) => <Tag key={item}>{item}</Tag>)}</Space> },
                { title: "积分", dataIndex: "creditCost" }, { title: "并发", dataIndex: "concurrencyLimit" },
                { title: "状态", render: (_, record: ServerModel) => <Tag color={record.enabled ? "green" : "red"}>{record.enabled ? "启用" : "停用"}</Tag> },
                { title: "操作", render: (_, record: ServerModel) => <Button size="small" onClick={() => editModel(record)}>编辑</Button> },
            ]} />
            <section className="rounded-md border border-stone-200 bg-white p-4">
                <h3 className="mb-4 text-base font-semibold">{editingModelId ? "编辑模型" : "新增模型"}</h3>
                <Form form={modelForm} layout="vertical" initialValues={{ capabilities: ["generate"], creditCost: 4, rmbCost: 0.4, concurrencyLimit: 5, enabled: true }} onFinish={saveModel}>
                    <Form.Item name="providerId" label="Provider" rules={[{ required: true }]}><Select options={providers.map((item) => ({ label: item.name, value: item.id }))} /></Form.Item>
                    <Form.Item name="workflowConfigId" label="工作流（可选）"><Select allowClear options={workflows.map((item)=>({label:`${item.name} · ${item.protocol}`,value:item.id}))}/></Form.Item>
                    <Form.Item name="name" label="显示名称" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name="modelId" label="模型 ID" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name="capabilities" label="支持能力" rules={[{ required: true }]}><Select mode="multiple" options={capabilityOptions} /></Form.Item>
                    <div className="grid grid-cols-3 gap-2"><Form.Item name="creditCost" label="积分"><InputNumber className="w-full" min={0} /></Form.Item><Form.Item name="rmbCost" label="成本"><InputNumber className="w-full" min={0} precision={4} /></Form.Item><Form.Item name="concurrencyLimit" label="并发"><InputNumber className="w-full" min={1} max={100} /></Form.Item></div>
                    <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                    <Button type="primary" htmlType="submit" block>保存到服务端</Button>
                </Form>
            </section>
        </div>
    );
}
