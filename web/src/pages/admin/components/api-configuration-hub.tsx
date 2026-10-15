import { Alert, App, Button, Empty, Form, Input, InputNumber, Modal, Select, Switch, Tabs, Tag } from "antd";
import { Boxes, KeyRound, Search, Settings2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiProviderPanel } from "@/pages/admin/components/api-provider-panel";
import { InternalAiProviderConfig } from "@/pages/admin/components/internal-ai-provider-config";
import { ModelPricingPanel } from "@/pages/admin/components/model-pricing-panel";
import { WorkflowManagementPanel } from "@/pages/admin/components/workflow-management-panel";
import { buildToolConfigurationInput, compatibleToolModels, completeToolConfigurations, toolConfigurationState } from "@/pages/admin/components/tool-configuration-state";
import {
    listServerModels, listServerProviders, listServerWorkflows, listToolApiConfigurations, updateToolApiConfiguration,
    type ServerModel, type ServerProvider, type ServerWorkflow, type ToolApiConfiguration, type ToolApiConfigurationInput,
} from "@/services/api/model-configuration";
import { moduleIsEnabled, nonAiDefinitions, toolDefinitions } from "@/services/api/modules";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useModuleStore } from "@/stores/use-module-store";

export function ApiConfigurationHub({ isAdmin }: { isAdmin: boolean }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<ToolApiConfigurationInput>();
    const [tools, setTools] = useState<ToolApiConfiguration[]>([]);
    const [providers, setProviders] = useState<ServerProvider[]>([]);
    const [models, setModels] = useState<ServerModel[]>([]);
    const [workflows, setWorkflows] = useState<ServerWorkflow[]>([]);
    const [selectedTool, setSelectedTool] = useState<ToolApiConfiguration | null>(null);
    const [activeTab, setActiveTab] = useState("tools");
    const [search, setSearch] = useState("");
    const [group, setGroup] = useState("all");
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const refreshBusinessConfig = useBusinessConfigStore((state) => state.refresh);
    const flags = useModuleStore((state) => state.flags);
    const refreshModules = useModuleStore((state) => state.refresh);

    const refresh = async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const [toolResult, providerResult, modelResult, workflowResult] = await Promise.all([
                listToolApiConfigurations(), listServerProviders(), listServerModels(), listServerWorkflows(), refreshModules(),
            ]);
            setTools(completeToolConfigurations(toolResult.tools));
            setProviders(providerResult.providers);
            setModels(modelResult.models);
            setWorkflows(workflowResult.workflows);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "板块 API 配置加载失败");
        } finally { setLoading(false); }
    };
    useEffect(() => { void refresh(); }, []);

    const openTool = (tool: ToolApiConfiguration) => {
        form.resetFields();
        form.setFieldsValue(buildToolConfigurationInput(tool, tool));
        setSelectedTool(tool);
    };
    const openAdvanced = (tab: "providers" | "models") => {
        setSelectedTool(null);
        setActiveTab(tab);
    };
    const save = async (values: ToolApiConfigurationInput) => {
        if (!selectedTool) return;
        setSaving(true);
        try {
            // Board saves never mutate a shared provider/model or global operation price.
            await updateToolApiConfiguration(selectedTool.toolKey, buildToolConfigurationInput(selectedTool, values));
            setSelectedTool(null);
            form.resetFields();
            await refresh();
            try {
                await refreshBusinessConfig();
                message.success(`${selectedTool.label}已保存并同步，仅影响当前板块`);
            } catch {
                message.warning("板块配置已保存，但设计师端配置刷新失败；重新加载页面后重试同步。");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "板块 API 配置保存失败");
        } finally { setSaving(false); }
    };

    const groups = useMemo(() => Array.from(new Set(tools.map((tool) => tool.group))), [tools]);
    const filteredTools = tools.filter((tool) => (group === "all" || tool.group === group)
        && `${tool.label} ${tool.toolKey} ${tool.group} ${tool.modelName || ""} ${tool.providerName || ""}`.toLowerCase().includes(search.trim().toLowerCase()));
    const selectedModels = selectedTool ? compatibleToolModels(selectedTool, models, providers, workflows) : [];

    return (
        <div className="space-y-4">
            <Alert type="info" showIcon title={`${toolDefinitions.length} 个 AI 板块独立配置`} description={`这里仅保存板块模型绑定、API 开关和费用覆盖，不会修改共用模型或全局价格。API 服务、密钥与新增模型请使用高级页；${nonAiDefinitions.length} 个非 AI 模块在“模块开关”中管理。`} />
            <Tabs activeKey={activeTab} onChange={(key) => { setActiveTab(key); if (key === "tools") void refresh(); }} items={[
                {
                    key: "tools",
                    label: <span className="inline-flex items-center gap-2"><Settings2 className="size-4" />板块配置（{toolDefinitions.length}）</span>,
                    children: <div className="space-y-4">
                        <div className="flex flex-wrap gap-3">
                            <Input className="!w-full sm:!w-80" value={search} onChange={(event) => setSearch(event.target.value)} allowClear prefix={<Search className="size-4" />} placeholder="搜索板块、模型或 API 服务" aria-label="搜索 AI 板块" />
                            <Select className="!w-44" value={group} onChange={setGroup} aria-label="AI 板块分组" options={[{ value: "all", label: "全部分组" }, ...groups.map((item) => ({ value: item, label: item }))]} />
                            <Button onClick={() => void refresh()} loading={loading}>刷新配置</Button>
                            <span className="self-center text-xs text-[var(--muted-foreground)]">显示 {filteredTools.length} / {tools.length} 个正式 AI 板块</span>
                        </div>
                        {loadError ? <Alert type="error" showIcon title="配置加载失败" description={loadError} /> : null}
                        {!loading && !loadError && !filteredTools.length ? <Empty description="没有匹配的板块" /> : null}
                        {groups.filter((name) => filteredTools.some((tool) => tool.group === name)).map((name) => <section key={name} className="space-y-3">
                            <h3 className="text-sm font-semibold text-[var(--foreground)]">{name}</h3>
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                {filteredTools.filter((tool) => tool.group === name).map((tool) => {
                                    const state = toolConfigurationState(tool, compatibleToolModels(tool, models, providers, workflows));
                                    const moduleEnabled = moduleIsEnabled(flags, tool.toolKey);
                                    return <section key={tool.toolKey} className="wb-surface flex flex-col p-5" data-tool-key={tool.toolKey}>
                                        <div className="flex items-start justify-between gap-3">
                                            <h4 className="font-semibold text-[var(--foreground)]">{tool.label}</h4>
                                            <Tag color={!tool.enabled ? "default" : state.ready ? "green" : "orange"}>{state.label}</Tag>
                                        </div>
                                        <p className="mt-2 break-words text-xs text-[var(--muted-foreground)]">{tool.providerName || "继承可用 API 服务"} · {tool.modelName || "未固定模型"}</p>
                                        <div className="mt-3 flex-1 space-y-2 text-sm text-[var(--muted-foreground)]">
                                            <p>{state.reason}</p>
                                            {!moduleEnabled ? <Tag color="orange">模块入口或所属总入口已关闭</Tag> : null}
                                            {tool.operationType === "chat" ? <Tag>不计积分</Tag> : <p className="text-xs">{tool.creditCostOverride == null ? "积分：继承操作与模型价格" : `积分：${tool.creditCostOverride} / 次（总额）`}<br />{tool.rmbCostOverride == null ? "成本：继承操作与模型价格" : `成本：￥${tool.rmbCostOverride.toFixed(4)} / 次（总额）`}</p>}
                                            {tool.workflowName ? <p className="text-xs">工作流：{tool.workflowName}</p> : null}
                                            <p className="text-xs">配置版本：{tool.configurationVersion}</p>
                                        </div>
                                        <Button className="mt-4" icon={<Settings2 className="size-4" />} onClick={() => openTool(tool)} disabled={!isAdmin || loading || Boolean(loadError)} block>配置本板块</Button>
                                    </section>;
                                })}
                            </div>
                        </section>)}
                    </div>,
                },
                { key: "providers", label: <span className="inline-flex items-center gap-2"><KeyRound className="size-4" />API 服务与密钥</span>, children: <div className="space-y-4"><Alert type="warning" showIcon title="共用服务配置" description="此处的 API 服务与密钥会被所有绑定该服务的模型共用；只需调整某个板块时，请返回板块配置。" /><InternalAiProviderConfig isAdmin={isAdmin} /><ApiProviderPanel isAdmin={isAdmin} /></div> },
                { key: "workflows", label: <span className="inline-flex items-center gap-2"><Workflow className="size-4" />工作流（高级）</span>, children: <WorkflowManagementPanel isAdmin={isAdmin} /> },
                { key: "models", label: <span className="inline-flex items-center gap-2"><Boxes className="size-4" />模型（高级）</span>, children: <div className="space-y-4"><Alert type="warning" showIcon title="共用模型配置" description="在此新增模型后，返回板块配置选择绑定。编辑已有模型会影响所有使用该模型的板块；需要隔离时请新增模型。" /><ModelPricingPanel mode="models" /></div> },
            ]} />
            <Modal title={selectedTool ? `配置${selectedTool.label}` : "配置板块"} open={Boolean(selectedTool)} onCancel={() => { if (!saving) setSelectedTool(null); }} footer={null} width={640} destroyOnHidden>
                <Form form={form} layout="vertical" disabled={!isAdmin || saving} onFinish={save}>
                    <Form.Item name="modelConfigId" label="本板块模型绑定" extra="留空即继承默认 / 由用户选择；固定绑定优先于用户选择。只显示已启用且能力兼容、API 可用的模型。">
                        <Select allowClear showSearch={{ optionFilterProp: "label" }} placeholder="继承默认 / 用户选择模型" options={selectedModels.map((model) => ({ value: model.id, label: `${model.name} · ${model.providerName} · ${model.modelId}` }))} />
                    </Form.Item>
                    {selectedTool?.modelConfigId && !selectedModels.some((model) => model.id === selectedTool.modelConfigId) ? <Alert className="mb-4" type="warning" showIcon title="当前绑定不可用" description="请重新选择可用模型或清空绑定；停用 API 不会自动改用其他模型。" /> : null}
                    {!selectedModels.length ? <Alert className="mb-4" type="warning" showIcon title="还没有兼容的可用模型" description="先配置 API 服务与密钥，再在模型高级页新增兼容模型。" /> : null}
                    <div className="mb-5 flex flex-wrap gap-2"><Button onClick={() => openAdvanced("providers")}>配置 / 新增 API 服务</Button><Button onClick={() => openAdvanced("models")}>新增 / 管理模型</Button></div>
                    {selectedTool?.operationType === "chat" ? <Alert className="mb-4" type="info" showIcon title="不计积分" description="当前对话板块不计积分，不设置板块费用覆盖。" /> : <>
                        <Alert className="mb-4" type="info" showIcon title="费用覆盖为每次调用总额" description="留空继承“操作价格 + 模型价格”；填写后替代该合计，仅当前板块生效。0 是有效值，不表示继承。" />
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Form.Item name="creditCostOverride" label="积分总额 / 次（可选）"><InputNumber className="w-full" min={0} precision={0} placeholder="留空继承" /></Form.Item>
                            <Form.Item name="rmbCostOverride" label="人民币成本总额 / 次（可选）"><InputNumber className="w-full" min={0} precision={4} placeholder="留空继承" /></Form.Item>
                        </div>
                    </>}
                    <Form.Item name="enabled" label="本板块 API 启用" valuePropName="checked" extra="与模块入口开关独立；关闭后禁止本板块调用，不回退到其他模型。"><Switch /></Form.Item>
                    <Button className="!h-10" type="primary" htmlType="submit" loading={saving} block>仅保存当前板块并同步</Button>
                </Form>
            </Modal>
        </div>
    );
}
