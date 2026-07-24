import { Alert, App, Button, Form, Input, InputNumber, Modal, Segmented, Select, Switch, Tabs, Tag } from "antd";
import { Boxes, CheckCircle2, KeyRound, Settings2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiProviderPanel } from "@/pages/admin/components/api-provider-panel";
import { InternalAiProviderConfig } from "@/pages/admin/components/internal-ai-provider-config";
import { ModelPricingPanel } from "@/pages/admin/components/model-pricing-panel";
import { WorkflowManagementPanel } from "@/pages/admin/components/workflow-management-panel";
import {
    createPriceDraft,
    createServerModel,
    createServerProvider,
    listServerModels,
    listServerProviders,
    listServerWorkflows,
    listToolApiConfigurations,
    publishPrice,
    updateServerModel,
    updateServerProvider,
    updateToolApiConfiguration,
    type ProviderProtocol,
    type ServerModel,
    type ServerProvider,
    type ServerWorkflow,
    type ToolApiConfiguration,
} from "@/services/api/model-configuration";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";

type QuickValues = {
    providerMode: "existing" | "new";
    providerId?: string;
    providerName?: string;
    protocol: ProviderProtocol;
    baseUrl?: string;
    apiKey?: string;
    modelName: string;
    modelId: string;
    workflowConfigId?: string;
    modelCredits: number;
    modelRmbCost: number;
    concurrencyLimit: number;
    operationCredits: number;
    operationRmbCost: number;
    enabled: boolean;
};

const protocolOptions = [
    { value: "openai", label: "OpenAI 兼容" },
    { value: "gemini", label: "Gemini" },
    { value: "apimart", label: "APIMart 图片异步（GPT / Gemini / Midjourney）" },
    { value: "volcengine", label: "火山引擎" },
    { value: "runninghub", label: "RunningHub" },
    { value: "comfyui", label: "ComfyUI" },
    { value: "custom", label: "公司内部/自定义" },
] satisfies Array<{ value: ProviderProtocol; label: string }>;

export function ApiConfigurationHub({ isAdmin }: { isAdmin: boolean }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<QuickValues>();
    const providerMode = Form.useWatch("providerMode", form);
    const selectedProviderId = Form.useWatch("providerId", form);
    const [tools, setTools] = useState<ToolApiConfiguration[]>([]);
    const [providers, setProviders] = useState<ServerProvider[]>([]);
    const [models, setModels] = useState<ServerModel[]>([]);
    const [workflows, setWorkflows] = useState<ServerWorkflow[]>([]);
    const [selectedTool, setSelectedTool] = useState<ToolApiConfiguration | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const refreshBusinessConfig = useBusinessConfigStore((state) => state.refresh);

    const refresh = async () => {
        setLoading(true);
        try {
            const [toolResult, providerResult, modelResult, workflowResult] = await Promise.all([
                listToolApiConfigurations(), listServerProviders(), listServerModels(), listServerWorkflows(),
            ]);
            setTools(toolResult.tools);
            setProviders(providerResult.providers);
            setModels(modelResult.models);
            setWorkflows(workflowResult.workflows);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "板块 API 配置加载失败");
        } finally { setLoading(false); }
    };
    useEffect(() => { void refresh(); }, []);

    const openTool = (tool: ToolApiConfiguration) => {
        const providerModeValue = tool.providerId || providers.length ? "existing" : "new";
        form.setFieldsValue({
            providerMode: providerModeValue,
            providerId: tool.providerId || providers[0]?.id,
            providerName: "",
            protocol: tool.protocol || "openai",
            baseUrl: "",
            apiKey: "",
            modelName: tool.modelName || `${tool.label}模型`,
            modelId: tool.modelId || "",
            workflowConfigId: tool.workflowConfigId || undefined,
            modelCredits: tool.modelCreditCost ?? 0,
            modelRmbCost: tool.modelRmbCost ?? 0,
            concurrencyLimit: models.find((model) => model.id === tool.modelConfigId)?.concurrencyLimit ?? 5,
            operationCredits: tool.price?.credits ?? 2,
            operationRmbCost: tool.price?.rmbCost ?? 0,
            enabled: tool.enabled || !tool.modelConfigId,
        });
        setSelectedTool(tool);
    };

    const save = async (values: QuickValues) => {
        if (!selectedTool) return;
        setSaving(true);
        try {
            let providerId = values.providerId;
            if (values.providerMode === "new") {
                const created = await createServerProvider({
                    name: values.providerName!, protocol: values.protocol, baseUrl: values.baseUrl!, enabled: true,
                    ...(values.apiKey ? { credentials: { apiKey: values.apiKey } } : {}),
                });
                providerId = created.provider.id;
            } else if (providerId && values.apiKey) {
                await updateServerProvider(providerId, { credentials: { apiKey: values.apiKey } });
            }
            if (!providerId) throw new Error("请选择 API 服务");
            const selectedWorkflow = values.workflowConfigId ? workflows.find((workflow) => workflow.id === values.workflowConfigId) : undefined;
            if (selectedWorkflow && selectedWorkflow.providerId !== providerId) throw new Error("工作流和 API 服务不属于同一个配置，请重新选择工作流");

            const existingModel = models.find((model) => model.id === selectedTool.modelConfigId);
            const modelInput = {
                providerId,
                workflowConfigId: values.workflowConfigId || null,
                replacementModelConfigId: existingModel?.replacementModelConfigId || null,
                name: values.modelName,
                modelId: values.modelId,
                capabilities: Array.from(new Set([...(existingModel?.capabilities || []), ...selectedTool.capabilities])),
                creditCost: values.modelCredits,
                rmbCost: values.modelRmbCost,
                concurrencyLimit: values.concurrencyLimit,
                enabled: true,
            };
            const model = selectedTool.modelConfigId
                ? (await updateServerModel(selectedTool.modelConfigId, modelInput)).model
                : (await createServerModel(modelInput)).model;
            const price = await createPriceDraft({
                operationType: selectedTool.operationType,
                label: selectedTool.label,
                credits: values.operationCredits,
                rmbCost: values.operationRmbCost,
            });
            await publishPrice(price.price.id);
            await updateToolApiConfiguration(selectedTool.toolKey, { modelConfigId: model.id, enabled: values.enabled });
            await Promise.all([refresh(), refreshBusinessConfig()]);
            message.success(`${selectedTool.label}的 API、模型和积分已同步到设计师端`);
            setSelectedTool(null);
            form.resetFields();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "板块 API 配置保存失败");
        } finally { setSaving(false); }
    };

    const workflowOptions = useMemo(() => workflows
        .filter((workflow) => !selectedProviderId || workflow.providerId === selectedProviderId)
        .map((workflow) => ({ label: `${workflow.name} · ${workflow.protocol}`, value: workflow.id })), [selectedProviderId, workflows]);

    return (
        <div className="space-y-4">
            <Alert type="info" showIcon title="按板块配置即可" description="普通接口只需填写 API 服务、模型 ID 和价格；只有 RunningHub、ComfyUI 或公司内部流程才需要选择工作流。API Key 只保存在服务端。" />
            <Tabs
                items={[
                    {
                        key: "tools",
                        label: <span className="inline-flex items-center gap-2"><Settings2 className="size-4" />板块配置</span>,
                        children: (
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                {tools.map((tool) => {
                                    const state = toolState(tool);
                                    return (
                                        <section key={tool.toolKey} className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                                            <div className="flex items-start justify-between gap-3">
                                                <div>
                                                    <h3 className="font-semibold text-stone-950 dark:text-stone-100">{tool.label}</h3>
                                                    <p className="mt-1 text-xs text-stone-500">{tool.providerName || "未选择 API 服务"} · {tool.modelName || "未选择模型"}</p>
                                                </div>
                                                <Tag color={state.ready ? "green" : "orange"}>{state.ready ? "已配置" : "待配置"}</Tag>
                                            </div>
                                            <div className="mt-4 min-h-12 text-sm text-stone-600 dark:text-stone-300">
                                                {state.ready ? `设计师端显示 ${state.credits} 积分/次` : state.reason}
                                                {tool.workflowName ? <div className="mt-1 text-xs text-stone-500">工作流：{tool.workflowName}</div> : null}
                                            </div>
                                            <Button icon={state.ready ? <CheckCircle2 className="size-4" /> : <Settings2 className="size-4" />} onClick={() => openTool(tool)} loading={loading} disabled={!isAdmin} block>
                                                {state.ready ? "修改配置" : "立即配置"}
                                            </Button>
                                        </section>
                                    );
                                })}
                            </div>
                        ),
                    },
                    { key: "providers", label: <span className="inline-flex items-center gap-2"><KeyRound className="size-4" />API 服务与密钥</span>, children: <div className="space-y-4"><InternalAiProviderConfig isAdmin={isAdmin} /><ApiProviderPanel isAdmin={isAdmin} /></div> },
                    { key: "workflows", label: <span className="inline-flex items-center gap-2"><Workflow className="size-4" />工作流（高级）</span>, children: <WorkflowManagementPanel isAdmin={isAdmin} /> },
                    { key: "models", label: <span className="inline-flex items-center gap-2"><Boxes className="size-4" />模型（高级）</span>, children: <ModelPricingPanel mode="models" /> },
                ]}
            />

            <Modal title={selectedTool ? `配置${selectedTool.label}` : "配置板块"} open={Boolean(selectedTool)} onCancel={() => setSelectedTool(null)} footer={null} width={720} destroyOnHidden>
                <Form form={form} layout="vertical" onFinish={save} initialValues={{ providerMode: "existing", protocol: "openai", modelCredits: 0, modelRmbCost: 0, concurrencyLimit: 5, operationCredits: 2, operationRmbCost: 0, enabled: true }}>
                    <Form.Item name="providerMode" label="API 服务来源"><Segmented block options={[{ label: "选择已有 API", value: "existing" }, { label: "新增 API", value: "new" }]} /></Form.Item>
                    {providerMode === "new" ? (
                        <>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <Form.Item name="providerName" label="API 服务名称" rules={[{ required: true }]}><Input placeholder="例如：公司 OpenAI" /></Form.Item>
                                <Form.Item name="protocol" label="接口协议" rules={[{ required: true }]}><Select options={protocolOptions} /></Form.Item>
                            </div>
                            <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://api.example.com/v1" /></Form.Item>
                        </>
                    ) : <Form.Item name="providerId" label="选择 API 服务" rules={[{ required: true }]}><Select options={providers.map((provider) => ({ label: `${provider.name} · ${provider.protocol}${provider.hasCredentials ? " · 已有密钥" : " · 未填密钥"}`, value: provider.id }))} /></Form.Item>}
                    <Form.Item name="apiKey" label="API Key"><Input.Password placeholder={providerMode === "existing" ? "留空保持现有密钥" : "密钥仅加密保存在服务端"} /></Form.Item>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Form.Item name="modelName" label="设计师看到的模型名称" rules={[{ required: true }]}><Input placeholder="例如：商品图精修模型" /></Form.Item>
                        <Form.Item name="modelId" label="模型 ID" rules={[{ required: true }]}><Input placeholder="例如：gpt-image-1" /></Form.Item>
                    </div>
                    <Form.Item name="workflowConfigId" label="工作流（可选）"><Select allowClear placeholder="普通 API 不用选择" options={workflowOptions} /></Form.Item>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <Form.Item name="modelCredits" label="模型附加积分" rules={[{ required: true }]}><InputNumber className="w-full" min={0} /></Form.Item>
                        <Form.Item name="modelRmbCost" label="模型人民币成本" rules={[{ required: true }]}><InputNumber className="w-full" min={0} precision={4} /></Form.Item>
                        <Form.Item name="concurrencyLimit" label="最大并发" rules={[{ required: true }]}><InputNumber className="w-full" min={1} max={100} /></Form.Item>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Form.Item name="operationCredits" label="板块基础积分" rules={[{ required: true }]}><InputNumber className="w-full" min={0} /></Form.Item>
                        <Form.Item name="operationRmbCost" label="板块人民币成本" rules={[{ required: true }]}><InputNumber className="w-full" min={0} precision={4} /></Form.Item>
                    </div>
                    {selectedTool?.operationType === "inpaint" ? <Alert className="mb-4" type="warning" showIcon title="图片编辑和角度控制共用局部编辑基础价格；模型绑定仍各自独立。" /> : null}
                    <Form.Item name="enabled" label="设计师端启用" valuePropName="checked"><Switch /></Form.Item>
                    <Button type="primary" htmlType="submit" loading={saving} block>保存并同步到设计师端</Button>
                </Form>
            </Modal>
        </div>
    );
}

function toolState(tool: ToolApiConfiguration) {
    if (!tool.modelConfigId) return { ready: false, reason: "尚未绑定模型", credits: 0 };
    if (!tool.enabled || !tool.modelEnabled || !tool.providerEnabled) return { ready: false, reason: "板块、模型或 API 服务已停用", credits: 0 };
    if (!tool.hasCredentials && tool.protocol !== "comfyui" && tool.protocol !== "custom") return { ready: false, reason: "API 服务尚未填写服务端密钥", credits: 0 };
    if (tool.workflowConfigId && !tool.workflowEnabled) return { ready: false, reason: "绑定的工作流已停用", credits: 0 };
    if (!tool.price) return { ready: false, reason: "尚未发布积分价格", credits: 0 };
    return { ready: true, reason: "", credits: tool.price.credits + (tool.modelCreditCost || 0) };
}
