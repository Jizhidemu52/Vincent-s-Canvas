import { useEffect, useMemo, useState } from "react";
import { App, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { GitBranchPlus, Trash2 } from "lucide-react";

import {
    createAdminWorkflow,
    type AdminWorkflowCapability,
    type AdminWorkflowConfig,
    type AdminWorkflowProviderProtocol,
    type AdminWorkflowTemplate,
} from "@/lib/admin-domain";
import { useAdminStore } from "@/stores/use-admin-store";

type WorkflowFormValues = {
    id: string;
    templateId: string;
    name: string;
    providerProtocol: AdminWorkflowProviderProtocol;
    providerId: string;
    capability: AdminWorkflowCapability;
    modelId: string;
    creditCost: number;
    rmbCost: number;
    entryCount: number;
    description: string;
    enabled: boolean;
};

const capabilityOptions: Array<{ label: string; value: AdminWorkflowCapability }> = [
    { label: "生成", value: "generate" },
    { label: "编辑", value: "edit" },
    { label: "放大", value: "upscale" },
    { label: "批量", value: "batch" },
];

const protocolOptions: Array<{ label: string; value: AdminWorkflowProviderProtocol }> = [
    { label: "RunningHub", value: "runninghub" },
    { label: "ComfyUI / 本地", value: "custom" },
];

export function WorkflowManagementPanel({ isAdmin }: { isAdmin: boolean }) {
    const { message } = App.useApp();
    const state = useAdminStore();
    const [form] = Form.useForm<WorkflowFormValues>();
    const [selectedWorkflowId, setSelectedWorkflowId] = useState(state.workflows[0]?.id || "");
    const selectedWorkflow = state.workflows.find((workflow) => workflow.id === selectedWorkflowId);
    const templateRows = useMemo(() => state.workflowTemplates.map((template) => ({ ...template, key: template.id })), [state.workflowTemplates]);

    useEffect(() => {
        if (selectedWorkflow) form.setFieldsValue(workflowToForm(selectedWorkflow));
        else if (!state.workflows.length && state.workflowTemplates[0]) form.setFieldsValue(workflowToForm(templateToWorkflow(state.workflowTemplates[0])));
    }, [form, selectedWorkflow, state.workflowTemplates, state.workflows.length]);

    const loadTemplate = (template: AdminWorkflowTemplate) => {
        const workflow = templateToWorkflow(template);
        setSelectedWorkflowId("");
        form.setFieldsValue(workflowToForm(workflow));
    };

    const submitWorkflow = (values: WorkflowFormValues) => {
        const workflow = createAdminWorkflow({ ...values, createdAt: selectedWorkflow?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
        const result = state.saveWorkflow(workflow);
        if (result.ok) {
            setSelectedWorkflowId(workflow.id);
            message.success("工作流配置已保存");
        } else {
            message.error(result.reason || "工作流保存失败");
        }
    };

    const deleteSelected = () => {
        if (!selectedWorkflow) return;
        const result = state.deleteWorkflow(selectedWorkflow.id);
        if (result.ok) {
            setSelectedWorkflowId("");
            form.resetFields();
            message.success("工作流已删除");
        } else {
            message.error(result.reason || "删除失败");
        }
    };

    return (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="grid gap-4">
                <section className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <Typography.Title level={3} className="!mb-0 !text-base">
                            模型能力模板
                        </Typography.Title>
                        <Tag className="m-0">{state.workflowTemplates.length}</Tag>
                    </div>
                    <Table
                        rowKey="id"
                        size="small"
                        pagination={false}
                        dataSource={templateRows}
                        columns={[
                            { title: "模板", dataIndex: "name" },
                            { title: "来源", render: (_, record: AdminWorkflowTemplate) => providerLabel(record.providerProtocol) },
                            { title: "能力", render: (_, record: AdminWorkflowTemplate) => capabilityLabel(record.capability) },
                            { title: "模型", dataIndex: "modelId" },
                            { title: "积分", dataIndex: "creditCost" },
                            { title: "入口数", dataIndex: "entryCount" },
                            {
                                title: "操作",
                                render: (_, record: AdminWorkflowTemplate) => (
                                    <Button size="small" icon={<GitBranchPlus className="size-3.5" />} disabled={!isAdmin} onClick={() => loadTemplate(record)}>
                                        使用模板
                                    </Button>
                                ),
                            },
                        ]}
                    />
                </section>

                <section className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <Typography.Title level={3} className="!mb-0 !text-base">
                            已配置工作流
                        </Typography.Title>
                        <Tag className="m-0">{state.workflows.length}</Tag>
                    </div>
                    <Table
                        rowKey="id"
                        size="small"
                        pagination={false}
                        dataSource={state.workflows}
                        columns={[
                            { title: "工作流", render: (_, record: AdminWorkflowConfig) => <Button type="link" className="!px-0" onClick={() => setSelectedWorkflowId(record.id)}>{record.name}</Button> },
                            { title: "Provider", dataIndex: "providerId" },
                            { title: "能力", render: (_, record: AdminWorkflowConfig) => capabilityLabel(record.capability) },
                            { title: "状态", render: (_, record: AdminWorkflowConfig) => <Tag color={record.enabled ? "green" : "red"}>{record.enabled ? "启用" : "停用"}</Tag> },
                            { title: "积分", dataIndex: "creditCost" },
                            { title: "成本", render: (_, record: AdminWorkflowConfig) => `¥${record.rmbCost.toFixed(2)}` },
                        ]}
                    />
                </section>
            </div>

            <section className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                <Typography.Title level={3} className="!mb-4 !text-base">
                    工作流配置
                </Typography.Title>
                <Form form={form} layout="vertical" disabled={!isAdmin} onFinish={submitWorkflow}>
                    <Form.Item name="id" label="工作流 ID" rules={[{ required: true }]}>
                        <Input placeholder="runninghub-upscale-prod" />
                    </Form.Item>
                    <Form.Item name="templateId" label="模板 ID" rules={[{ required: true }]}>
                        <Input placeholder="runninghub-upscale" />
                    </Form.Item>
                    <Form.Item name="name" label="名称" rules={[{ required: true }]}>
                        <Input placeholder="高清放大" />
                    </Form.Item>
                    <div className="grid grid-cols-2 gap-3">
                        <Form.Item name="providerProtocol" label="来源" rules={[{ required: true }]}>
                            <Select options={protocolOptions} />
                        </Form.Item>
                        <Form.Item name="capability" label="能力" rules={[{ required: true }]}>
                            <Select options={capabilityOptions} />
                        </Form.Item>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <Form.Item name="providerId" label="Provider ID" rules={[{ required: true }]}>
                            <Input />
                        </Form.Item>
                        <Form.Item name="modelId" label="模型/工作流 ID" rules={[{ required: true }]}>
                            <Input />
                        </Form.Item>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <Form.Item name="creditCost" label="积分" rules={[{ required: true }]}>
                            <InputNumber className="w-full" min={0} max={100000} />
                        </Form.Item>
                        <Form.Item name="rmbCost" label="成本" rules={[{ required: true }]}>
                            <InputNumber className="w-full" min={0} max={100000} precision={2} />
                        </Form.Item>
                        <Form.Item name="entryCount" label="入口数">
                            <InputNumber className="w-full" min={0} max={10000} />
                        </Form.Item>
                    </div>
                    <Form.Item name="description" label="说明">
                        <Input.TextArea rows={3} />
                    </Form.Item>
                    <Form.Item name="enabled" label="启用" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    <Space className="w-full" orientation="vertical">
                        <Button type="primary" htmlType="submit" block>
                            保存工作流
                        </Button>
                        <Button danger block icon={<Trash2 className="size-4" />} disabled={!selectedWorkflow} onClick={deleteSelected}>
                            删除当前工作流
                        </Button>
                    </Space>
                </Form>
            </section>
        </div>
    );
}

function templateToWorkflow(template: AdminWorkflowTemplate): AdminWorkflowConfig {
    const now = new Date().toISOString();
    return createAdminWorkflow({ ...template, templateId: template.id, id: `${template.id}-prod`, enabled: true, createdAt: now, updatedAt: now });
}

function workflowToForm(workflow: AdminWorkflowConfig): WorkflowFormValues {
    return {
        id: workflow.id,
        templateId: workflow.templateId,
        name: workflow.name,
        providerProtocol: workflow.providerProtocol,
        providerId: workflow.providerId,
        capability: workflow.capability,
        modelId: workflow.modelId,
        creditCost: workflow.creditCost,
        rmbCost: workflow.rmbCost,
        entryCount: workflow.entryCount,
        description: workflow.description,
        enabled: workflow.enabled,
    };
}

function providerLabel(protocol: AdminWorkflowProviderProtocol) {
    return protocol === "runninghub" ? "RunningHub" : "ComfyUI / 本地";
}

function capabilityLabel(capability: AdminWorkflowCapability) {
    const labels: Record<AdminWorkflowCapability, string> = {
        generate: "生成",
        edit: "编辑",
        upscale: "放大",
        batch: "批量",
    };
    return labels[capability];
}
