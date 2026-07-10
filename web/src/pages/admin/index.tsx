import type { ReactNode } from "react";
import { Download, Edit3, LogOut, ShieldCheck, SlidersHorizontal, UserPlus, UsersRound, WalletCards } from "lucide-react";
import { useMemo, useState } from "react";
import { App, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tabs, Tag, Typography } from "antd";
import { saveAs } from "file-saver";
import { Link, Navigate, useSearchParams } from "react-router-dom";

import { type AdminModelCapability, type AdminModelConfig, type AdminOperationType, type AdminRole, type DesignerAccount, type DesignerStatus, type PricingRule } from "@/lib/admin-domain";
import { ApiProviderPanel } from "@/pages/admin/components/api-provider-panel";
import { WorkflowManagementPanel } from "@/pages/admin/components/workflow-management-panel";
import { useAdminStore } from "@/stores/use-admin-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const operationOptions: Array<{ label: string; value: AdminOperationType }> = [
    { label: "生成一张图", value: "image_generation" },
    { label: "放大图片", value: "upscale" },
    { label: "去背景", value: "remove_background" },
    { label: "局部编辑", value: "inpaint" },
    { label: "批量处理每张图", value: "batch_image" },
    { label: "无缝拼接", value: "seamless_stitch" },
];

const capabilityOptions: Array<{ label: string; value: AdminModelCapability }> = [
    { label: "生成", value: "generate" },
    { label: "编辑", value: "edit" },
    { label: "放大", value: "upscale" },
    { label: "去背景", value: "remove_background" },
    { label: "批量", value: "batch" },
];

type CreditFormValues = {
    designerId: string;
    amount: number;
    reason: string;
};

type LimitFormValues = {
    designerId: string;
    quotaLimit: number;
};

type AccountFormValues = {
    loginName: string;
    password?: string;
    name: string;
    role: AdminRole;
    status: DesignerStatus;
    quotaRemaining: number;
    quotaLimit: number;
};

type PricingFormValues = {
    operationType: AdminOperationType;
    label: string;
    credits: number;
    rmbCost: number;
};

type ModelFormValues = AdminModelConfig;

export default function AdminPage() {
    const { message } = App.useApp();
    const [creditForm] = Form.useForm<CreditFormValues>();
    const [limitForm] = Form.useForm<LimitFormValues>();
    const [accountForm] = Form.useForm<AccountFormValues>();
    const [pricingForm] = Form.useForm<PricingFormValues>();
    const [modelForm] = Form.useForm<ModelFormValues>();
    const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
    const [historyDesigner, setHistoryDesigner] = useState<string>("all");
    const [historyModel, setHistoryModel] = useState<string>("all");
    const [historyOperation, setHistoryOperation] = useState<string>("all");
    const [assetDesigner, setAssetDesigner] = useState<string>("all");
    const [searchParams, setSearchParams] = useSearchParams();
    const state = useAdminStore();
    const projects = useCanvasStore((store) => store.projects);
    const assets = useAssetStore((store) => store.assets);
    const currentOperator = state.designers.find((designer) => designer.id === state.adminSession?.userId);
    const isAdmin = currentOperator?.role === "admin";

    if (!state.canAccessAdmin()) return <Navigate to="/admin/login" replace />;

    const designerOptions = state.designers.map((designer) => ({
        label: `${designer.name}（${designer.role === "admin" ? "管理员" : "设计师"}）`,
        value: designer.id,
    }));

    const activeDesigner = state.designers.find((designer) => designer.id === state.activeDesignerId);
    const totalRemaining = state.designers.reduce((sum, designer) => sum + designer.quotaRemaining, 0);
    const totalUsed = state.designers.reduce((sum, designer) => sum + designer.quotaUsed, 0);
    const totalCost = state.ledger.reduce((sum, item) => sum + item.rmb, 0);

    const filteredHistory = useMemo(
        () =>
            state.history.filter((record) => {
                if (historyDesigner !== "all" && record.designerId !== historyDesigner) return false;
                if (historyModel !== "all" && record.modelId !== historyModel) return false;
                if (historyOperation !== "all" && record.operationType !== historyOperation) return false;
                return true;
            }),
        [historyDesigner, historyModel, historyOperation, state.history],
    );

    const projectRows = useMemo(
        () =>
            projects.map((project) => {
                const projectHistory = state.history.filter((record) => record.projectId === project.id);
                return {
                    id: project.id,
                    title: project.title,
                    status: project.nodes.length ? "使用中" : "空项目",
                    nodes: project.nodes.length,
                    tasks: projectHistory.length,
                    credits: projectHistory.reduce((sum, record) => sum + record.credits, 0),
                    updatedAt: project.updatedAt,
                };
            }),
        [projects, state.history],
    );

    const materialRows = useMemo(
        () =>
            [
                ...state.materials.map((item) => ({ ...item, kind: "后台历史", source: item.operationType })),
                ...assets.map((asset) => ({
                    id: asset.id,
                    projectId: String(asset.metadata?.projectId || "未归属"),
                    designerId: asset.ownerId || String(asset.metadata?.designerId || "未归属"),
                    operationType: String(asset.metadata?.operationType || "素材库"),
                    title: asset.title,
                    url: asset.coverUrl,
                    createdAt: asset.createdAt,
                    kind: asset.kind,
                    source: asset.source || "素材库",
                })),
            ].filter((item) => assetDesigner === "all" || item.designerId === assetDesigner),
        [assetDesigner, assets, state.materials],
    );

    const activeAdminTab = searchParams.get("tab") || "accounts";
    const changeAdminTab = (tab: string) => {
        setSearchParams(tab === "accounts" ? {} : { tab }, { replace: true });
    };
    const adminTabOptions = [
        { key: "accounts", label: "账号额度" },
        { key: "pricing", label: "积分价格" },
        { key: "providers", label: "API Provider" },
        { key: "workflows", label: "工作流管理" },
        { key: "models", label: "模型 API" },
        { key: "history", label: "历史记录" },
        { key: "projects", label: "项目素材" },
        { key: "batch", label: "批量任务" },
        { key: "audit", label: "审计日志" },
    ];

    const submitCreditChange = (values: CreditFormValues) => {
        const result = state.changeDesignerCredits(values.designerId, values.amount, values.reason || "管理员调整");
        showActionResult(result, message, "额度已调整");
    };

    const submitLimitChange = (values: LimitFormValues) => {
        const result = state.changeDesignerQuotaLimit(values.designerId, values.quotaLimit);
        showActionResult(result, message, "额度上限已更新");
    };

    const submitAccount = (values: AccountFormValues) => {
        const existing = editingAccountId ? state.designers.find((designer) => designer.id === editingAccountId) : undefined;
        const result = state.saveDesignerAccount({
            id: editingAccountId || undefined,
            ...values,
            quotaUsed: existing?.quotaUsed || 0,
        });
        showActionResult(result, message, editingAccountId ? "账号已更新，设计师端会同步最新权限和额度" : "账号已开通，设计师可用账号密码登录");
        if (result.ok) {
            setEditingAccountId(null);
            accountForm.resetFields();
            accountForm.setFieldsValue({ role: "designer", status: "active", quotaRemaining: 500, quotaLimit: 500 });
        }
    };

    const editAccount = (designer: DesignerAccount) => {
        setEditingAccountId(designer.id);
        accountForm.setFieldsValue({
            loginName: designer.loginName || designer.id,
            password: "",
            name: designer.name,
            role: designer.role,
            status: designer.status,
            quotaRemaining: designer.quotaRemaining,
            quotaLimit: designer.quotaLimit,
        });
    };

    const submitPricingRule = (values: PricingFormValues) => {
        const result = state.savePricingRule(values);
        showActionResult(result, message, "价格规则已保存");
    };

    const submitModel = (values: ModelFormValues) => {
        const model: AdminModelConfig = {
            ...values,
            id: values.id || values.modelId,
            capabilities: values.capabilities || [],
            enabled: Boolean(values.enabled),
        };
        const result = state.saveModelConfig(model);
        showActionResult(result, message, "模型配置已保存");
    };

    const exportHistory = () => {
        const csv = toCsv(
            filteredHistory.map((record) => ({
                时间: record.createdAt,
                操作人: designerName(state.designers, record.designerId),
                项目: record.projectId,
                操作类型: operationLabel(record.operationType),
                模型: modelName(state.models, record.modelId),
                数量: record.quantity,
                积分: record.credits,
                金额: record.rmb,
                状态: record.status === "success" ? "成功" : "失败",
                失败原因: record.failureReason || "",
                提示词: record.prompt,
            })),
        );
        saveAs(new Blob([csv], { type: "text/csv;charset=utf-8" }), `wireless-canvas-history-${Date.now()}.csv`);
        message.success("历史记录已导出");
    };

    return (
        <div className="h-full overflow-y-auto bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-5">
                <section className="flex flex-col gap-4 border-b border-stone-200 pb-4 dark:border-stone-800 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <div className="text-xs font-medium text-stone-500 dark:text-stone-400">后台管理</div>
                        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">账号额度、模型价格与历史审计</h1>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900">
                            当前管理员：<span className="font-medium">{currentOperator?.name}</span>
                        </div>
                        <Button
                            icon={<LogOut className="size-4" />}
                            onClick={() => {
                                state.logoutAdmin();
                                message.success("已退出后台");
                            }}
                        >
                            退出
                        </Button>
                    </div>
                </section>

                <section className="grid gap-3 md:grid-cols-4">
                    <Metric icon={<UsersRound className="size-4" />} label="设计师账号" value={String(state.designers.length)} />
                    <Metric icon={<WalletCards className="size-4" />} label="剩余额度" value={totalRemaining.toLocaleString()} />
                    <Metric icon={<SlidersHorizontal className="size-4" />} label="已用额度" value={totalUsed.toLocaleString()} />
                    <Metric icon={<ShieldCheck className="size-4" />} label="人民币成本" value={`￥${totalCost.toFixed(2)}`} />
                </section>

                {!isAdmin ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
                        当前操作人是普通设计师，只能查看后台数据，不能修改额度、价格和模型配置。
                    </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                    {adminTabOptions.map((tab) => (
                        <Link
                            key={tab.key}
                            to={tab.key === "accounts" ? "/admin" : `/admin?tab=${tab.key}`}
                            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                                activeAdminTab === tab.key
                                    ? "border-orange-500 bg-orange-600 text-white shadow-sm"
                                    : "border-stone-200 bg-white text-stone-700 hover:border-orange-300 hover:text-orange-700 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-orange-700 dark:hover:text-orange-300"
                            }`}
                        >
                            {tab.label}
                        </Link>
                    ))}
                </div>

                <div>
                    <Tabs
                        className="admin-tabs"
                        activeKey={activeAdminTab}
                        onChange={changeAdminTab}
                        onTabClick={changeAdminTab}
                        renderTabBar={() => <></>}
                        items={[
                            {
                                key: "accounts",
                                label: "账号额度",
                                children: (
                                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                                        <Table
                                            rowKey="id"
                                            size="small"
                                            pagination={false}
                                            dataSource={state.designers}
                                            columns={[
                                                { title: "姓名", dataIndex: "name" },
                                                { title: "登录账号", render: (_, record: DesignerAccount) => record.loginName || record.id },
                                                { title: "角色", render: (_, record: DesignerAccount) => <Tag color={record.role === "admin" ? "blue" : "default"}>{record.role === "admin" ? "管理员" : "设计师"}</Tag> },
                                                { title: "状态", render: (_, record: DesignerAccount) => <Tag color={record.status === "active" ? "green" : "red"}>{record.status === "active" ? "启用" : "停用"}</Tag> },
                                                { title: "剩余额度", dataIndex: "quotaRemaining", sorter: (a, b) => a.quotaRemaining - b.quotaRemaining },
                                                { title: "已用额度", dataIndex: "quotaUsed", sorter: (a, b) => a.quotaUsed - b.quotaUsed },
                                                { title: "额度上限", dataIndex: "quotaLimit" },
                                                {
                                                    title: "操作",
                                                    render: (_, record: DesignerAccount) => (
                                                        <Button size="small" icon={<Edit3 className="size-3.5" />} onClick={() => editAccount(record)}>
                                                            编辑
                                                        </Button>
                                                    ),
                                                },
                                            ]}
                                        />
                                        <div className="grid gap-3">
                                            <Panel title={editingAccountId ? "编辑账号权限" : "开通设计师账号"}>
                                                <Form form={accountForm} layout="vertical" disabled={!isAdmin} initialValues={{ role: "designer", status: "active", quotaRemaining: 500, quotaLimit: 500 }} onFinish={submitAccount}>
                                                    <Form.Item name="loginName" label="登录账号" rules={[{ required: true, message: "请输入登录账号" }]}>
                                                        <Input placeholder="例如：张三 / zhangsan / 邮箱 / 工号" disabled={Boolean(editingAccountId)} />
                                                    </Form.Item>
                                                    <Form.Item name="password" label={editingAccountId ? "新密码（留空不改）" : "初始密码"} rules={editingAccountId ? [] : [{ required: true, message: "请设置初始密码" }]}>
                                                        <Input.Password placeholder={editingAccountId ? "留空则保持原密码" : "给设计师的初始密码"} />
                                                    </Form.Item>
                                                    <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
                                                        <Input placeholder="设计师姓名" />
                                                    </Form.Item>
                                                    <Form.Item name="role" label="角色" rules={[{ required: true }]}>
                                                        <Select
                                                            options={[
                                                                { label: "普通设计师", value: "designer" },
                                                                { label: "管理员", value: "admin" },
                                                            ]}
                                                        />
                                                    </Form.Item>
                                                    <Form.Item name="status" label="状态" rules={[{ required: true }]}>
                                                        <Select
                                                            options={[
                                                                { label: "启用", value: "active" },
                                                                { label: "停用", value: "disabled" },
                                                            ]}
                                                        />
                                                    </Form.Item>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <Form.Item name="quotaRemaining" label="当前剩余额度" rules={[{ required: true }]}>
                                                            <InputNumber className="w-full" min={0} max={1000000} />
                                                        </Form.Item>
                                                        <Form.Item name="quotaLimit" label="额度上限" rules={[{ required: true }]}>
                                                            <InputNumber className="w-full" min={0} max={1000000} />
                                                        </Form.Item>
                                                    </div>
                                                    <Space className="w-full" orientation="vertical">
                                                        <Button type="primary" htmlType="submit" icon={<UserPlus className="size-4" />} block>
                                                            {editingAccountId ? "保存账号权限" : "开通账号"}
                                                        </Button>
                                                        {editingAccountId ? (
                                                            <Button
                                                                block
                                                                onClick={() => {
                                                                    setEditingAccountId(null);
                                                                    accountForm.resetFields();
                                                                    accountForm.setFieldsValue({ role: "designer", status: "active", quotaRemaining: 500, quotaLimit: 500 });
                                                                }}
                                                            >
                                                                取消编辑
                                                            </Button>
                                                        ) : null}
                                                    </Space>
                                                </Form>
                                                <Typography.Paragraph className="!mb-0 !mt-3 text-xs !text-stone-500">
                                                    登录账号支持中文名、英文账号、邮箱或工号。管理员修改角色、停用账号、调整额度后，设计师端读取同一份账号数据，余额和权限会同步生效。
                                                </Typography.Paragraph>
                                            </Panel>
                                            <Panel title="调整额度">
                                                <Form form={creditForm} layout="vertical" disabled={!isAdmin} initialValues={{ designerId: activeDesigner?.id, amount: 100, reason: "项目补充额度" }} onFinish={submitCreditChange}>
                                                    <Form.Item name="designerId" label="设计师" rules={[{ required: true }]}>
                                                        <Select options={designerOptions.filter((item) => state.designers.find((designer) => designer.id === item.value)?.role !== "admin")} />
                                                    </Form.Item>
                                                    <Form.Item name="amount" label="积分变化" rules={[{ required: true }]}>
                                                        <InputNumber className="w-full" min={-100000} max={100000} />
                                                    </Form.Item>
                                                    <Form.Item name="reason" label="原因">
                                                        <Input placeholder="例如：项目补充额度" />
                                                    </Form.Item>
                                                    <Button type="primary" htmlType="submit" block>
                                                        保存调整
                                                    </Button>
                                                </Form>
                                            </Panel>
                                            <Panel title="设置额度上限">
                                                <Form form={limitForm} layout="vertical" disabled={!isAdmin} initialValues={{ designerId: activeDesigner?.id, quotaLimit: activeDesigner?.quotaLimit || 500 }} onFinish={submitLimitChange}>
                                                    <Form.Item name="designerId" label="设计师" rules={[{ required: true }]}>
                                                        <Select options={designerOptions.filter((item) => state.designers.find((designer) => designer.id === item.value)?.role !== "admin")} />
                                                    </Form.Item>
                                                    <Form.Item name="quotaLimit" label="最多可拥有积分" rules={[{ required: true }]}>
                                                        <InputNumber className="w-full" min={0} max={1000000} />
                                                    </Form.Item>
                                                    <Button htmlType="submit" block>
                                                        更新上限
                                                    </Button>
                                                </Form>
                                            </Panel>
                                        </div>
                                    </div>
                                ),
                            },
                            {
                                key: "pricing",
                                label: "积分价格",
                                children: (
                                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                                        <Table
                                            rowKey="operationType"
                                            size="small"
                                            pagination={false}
                                            dataSource={state.pricingRules}
                                            columns={[
                                                { title: "操作", render: (_, record: PricingRule) => operationLabel(record.operationType) },
                                                { title: "后台名称", dataIndex: "label" },
                                                { title: "积分/次", dataIndex: "credits" },
                                                { title: "人民币成本/次", render: (_, record: PricingRule) => `￥${record.rmbCost.toFixed(2)}` },
                                            ]}
                                        />
                                        <Panel title="修改价格规则">
                                            <Form form={pricingForm} layout="vertical" disabled={!isAdmin} initialValues={{ operationType: "image_generation", label: "生成一张图", credits: 8, rmbCost: 0.8 }} onFinish={submitPricingRule}>
                                                <Form.Item name="operationType" label="操作类型" rules={[{ required: true }]}>
                                                    <Select options={operationOptions} />
                                                </Form.Item>
                                                <Form.Item name="label" label="显示名称" rules={[{ required: true }]}>
                                                    <Input />
                                                </Form.Item>
                                                <Form.Item name="credits" label="积分" rules={[{ required: true }]}>
                                                    <InputNumber className="w-full" min={0} max={100000} />
                                                </Form.Item>
                                                <Form.Item name="rmbCost" label="人民币成本" rules={[{ required: true }]}>
                                                    <InputNumber className="w-full" min={0} max={100000} precision={2} />
                                                </Form.Item>
                                                <Button type="primary" htmlType="submit" block>
                                                    保存规则
                                                </Button>
                                            </Form>
                                        </Panel>
                                    </div>
                                ),
                            },
                            {
                                key: "providers",
                                label: "API Provider",
                                children: <ApiProviderPanel isAdmin={isAdmin} />,
                            },
                            {
                                key: "workflows",
                                label: "工作流管理",
                                children: <WorkflowManagementPanel isAdmin={isAdmin} />,
                            },
                            {
                                key: "models",
                                label: "模型 API",
                                children: (
                                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
                                        <Table
                                            rowKey="id"
                                            size="small"
                                            dataSource={state.models}
                                            columns={[
                                                { title: "模型名称", dataIndex: "name" },
                                                { title: "模型 ID", dataIndex: "modelId" },
                                                { title: "Provider", dataIndex: "provider" },
                                                {
                                                    title: "能力",
                                                    render: (_, record: AdminModelConfig) => (
                                                        <Space wrap>
                                                            {record.capabilities.map((item) => (
                                                                <Tag key={item}>{capabilityLabel(item)}</Tag>
                                                            ))}
                                                        </Space>
                                                    ),
                                                },
                                                { title: "积分", dataIndex: "credits" },
                                                { title: "成本", render: (_, record: AdminModelConfig) => `￥${record.rmbCost.toFixed(2)}` },
                                                { title: "状态", render: (_, record: AdminModelConfig) => <Tag color={record.enabled ? "green" : "red"}>{record.enabled ? "启用" : "停用"}</Tag> },
                                            ]}
                                        />
                                        <Panel title="配置模型">
                                            <Form
                                                form={modelForm}
                                                layout="vertical"
                                                disabled={!isAdmin}
                                                initialValues={{ id: "", name: "", modelId: "", provider: "", capabilities: ["generate"], credits: 4, rmbCost: 0.4, enabled: true }}
                                                onFinish={submitModel}
                                            >
                                                <Form.Item name="id" label="后台唯一 ID">
                                                    <Input placeholder="留空时使用模型 ID" />
                                                </Form.Item>
                                                <Form.Item name="name" label="模型名称" rules={[{ required: true }]}>
                                                    <Input placeholder="GPT Image 2" />
                                                </Form.Item>
                                                <Form.Item name="modelId" label="模型 ID" rules={[{ required: true }]}>
                                                    <Input placeholder="gpt-image-2" />
                                                </Form.Item>
                                                <Form.Item name="provider" label="Provider / API 来源" rules={[{ required: true }]}>
                                                    <Input placeholder="OpenAI / Nano Banana / 内部模型" />
                                                </Form.Item>
                                                <Form.Item name="capabilities" label="支持能力" rules={[{ required: true }]}>
                                                    <Select mode="multiple" options={capabilityOptions} />
                                                </Form.Item>
                                                <div className="grid grid-cols-2 gap-3">
                                                    <Form.Item name="credits" label="模型积分" rules={[{ required: true }]}>
                                                        <InputNumber className="w-full" min={0} max={100000} />
                                                    </Form.Item>
                                                    <Form.Item name="rmbCost" label="模型成本" rules={[{ required: true }]}>
                                                        <InputNumber className="w-full" min={0} max={100000} precision={2} />
                                                    </Form.Item>
                                                </div>
                                                <Form.Item name="enabled" label="是否启用" valuePropName="checked">
                                                    <Switch />
                                                </Form.Item>
                                                <div className="mb-3 rounded-md bg-stone-100 px-3 py-2 text-xs leading-5 text-stone-600 dark:bg-stone-900 dark:text-stone-300">当前前端只保存模型元数据和价格，不保存 API Key；真实密钥需要服务端配置。</div>
                                                <Button type="primary" htmlType="submit" block>
                                                    保存模型
                                                </Button>
                                            </Form>
                                        </Panel>
                                    </div>
                                ),
                            },
                            {
                                key: "history",
                                label: "历史记录",
                                children: (
                                    <div className="grid gap-3">
                                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                            <Space wrap>
                                                <Select className="w-48" value={historyDesigner} onChange={setHistoryDesigner} options={[{ label: "全部设计师", value: "all" }, ...designerOptions]} />
                                                <Select className="w-48" value={historyModel} onChange={setHistoryModel} options={[{ label: "全部模型", value: "all" }, ...state.models.map((model) => ({ label: model.name, value: model.id }))]} />
                                                <Select className="w-48" value={historyOperation} onChange={setHistoryOperation} options={[{ label: "全部操作", value: "all" }, ...operationOptions]} />
                                            </Space>
                                            <Button icon={<Download className="size-4" />} onClick={exportHistory}>
                                                导出历史
                                            </Button>
                                        </div>
                                        <Table
                                            rowKey="id"
                                            size="small"
                                            dataSource={filteredHistory}
                                            columns={[
                                                { title: "时间", dataIndex: "createdAt", width: 180 },
                                                { title: "操作人", render: (_, record) => designerName(state.designers, record.designerId) },
                                                { title: "项目", dataIndex: "projectId" },
                                                { title: "操作", render: (_, record) => operationLabel(record.operationType) },
                                                { title: "模型", render: (_, record) => modelName(state.models, record.modelId) },
                                                { title: "数量", dataIndex: "quantity" },
                                                { title: "积分", dataIndex: "credits" },
                                                { title: "金额", render: (_, record) => `￥${record.rmb.toFixed(2)}` },
                                                { title: "状态", render: (_, record) => <Tag color={record.status === "success" ? "green" : "red"}>{record.status === "success" ? "成功" : "失败"}</Tag> },
                                                { title: "提示词", dataIndex: "prompt", ellipsis: true },
                                            ]}
                                        />
                                    </div>
                                ),
                            },
                            {
                                key: "projects",
                                label: "项目素材",
                                children: (
                                    <div className="grid gap-4">
                                        <Table
                                            rowKey="id"
                                            size="small"
                                            dataSource={projectRows}
                                            columns={[
                                                { title: "项目", dataIndex: "title" },
                                                { title: "状态", dataIndex: "status" },
                                                { title: "节点数", dataIndex: "nodes" },
                                                { title: "历史任务", dataIndex: "tasks" },
                                                { title: "消耗积分", dataIndex: "credits" },
                                                { title: "更新时间", dataIndex: "updatedAt" },
                                            ]}
                                        />
                                        <Table
                                            rowKey="id"
                                            size="small"
                                            title={() => (
                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                    <span>素材归档（管理员可查看全部设计师）</span>
                                                    <Select
                                                        className="w-64"
                                                        value={assetDesigner}
                                                        onChange={setAssetDesigner}
                                                        options={[{ label: "全部设计师", value: "all" }, ...designerOptions.filter((item) => state.designers.find((designer) => designer.id === item.value)?.role === "designer")]}
                                                    />
                                                </div>
                                            )}
                                            dataSource={materialRows}
                                            columns={[
                                                { title: "素材", dataIndex: "title" },
                                                { title: "项目", dataIndex: "projectId" },
                                                { title: "设计师", render: (_, record) => designerName(state.designers, record.designerId) },
                                                { title: "类型/来源", render: (_, record) => `${record.kind} · ${record.source}` },
                                                { title: "时间", dataIndex: "createdAt" },
                                            ]}
                                        />
                                    </div>
                                ),
                            },
                            {
                                key: "batch",
                                label: "批量任务",
                                children: (
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        dataSource={state.batchTasks}
                                        columns={[
                                            { title: "任务 ID", dataIndex: "id" },
                                            { title: "设计师", render: (_, record) => designerName(state.designers, record.designerId) },
                                            { title: "项目", dataIndex: "projectId" },
                                            { title: "模型", render: (_, record) => modelName(state.models, record.modelId) },
                                            { title: "整体状态", dataIndex: "status" },
                                            { title: "进度", render: (_, record) => `${record.items.filter((item) => item.status === "success").length}/${record.items.length}` },
                                            { title: "失败", render: (_, record) => record.items.filter((item) => item.status === "failed").length },
                                            { title: "消耗", render: (_, record) => record.items.reduce((sum, item) => sum + item.credits, 0) },
                                        ]}
                                    />
                                ),
                            },
                            {
                                key: "audit",
                                label: "审计日志",
                                children: (
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        dataSource={state.auditLogs}
                                        columns={[
                                            { title: "时间", dataIndex: "createdAt", width: 180 },
                                            { title: "操作人", render: (_, record) => designerName(state.designers, record.operatorId) },
                                            { title: "目标", dataIndex: "targetId" },
                                            { title: "行为", dataIndex: "action" },
                                            { title: "内容", dataIndex: "detail" },
                                            { title: "结果", render: (_, record) => <Tag color={record.result === "success" ? "green" : "red"}>{record.result === "success" ? "成功" : "失败"}</Tag> },
                                        ]}
                                    />
                                ),
                            },
                        ]}
                    />
                </div>

                <div className="rounded-md border border-stone-200 bg-white px-4 py-3 text-xs leading-5 text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
                    当前版本在浏览器本地持久化后台数据，适合单机管理和业务规则验证。API Key、真实管理员接口鉴权、服务端账本锁和外部模型代理需要后端落地后才能满足生产安全要求。
                </div>
            </main>
        </div>
    );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
    return (
        <div className="rounded-md border border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-900">
            <div className="flex items-center gap-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                {icon}
                {label}
            </div>
            <div className="mt-2 text-2xl font-semibold text-stone-950 dark:text-stone-100">{value}</div>
        </div>
    );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <Typography.Title level={3} className="!mb-4 !text-base">
                {title}
            </Typography.Title>
            {children}
        </section>
    );
}

function showActionResult(result: { ok: boolean; reason?: string }, message: ReturnType<typeof App.useApp>["message"], success: string) {
    if (result.ok) message.success(success);
    else message.error(result.reason || "操作失败");
}

function operationLabel(operation: string) {
    return operationOptions.find((item) => item.value === operation)?.label || operation;
}

function capabilityLabel(capability: AdminModelCapability) {
    return capabilityOptions.find((item) => item.value === capability)?.label || capability;
}

function designerName(designers: DesignerAccount[], id: string) {
    return designers.find((designer) => designer.id === id)?.name || id;
}

function modelName(models: AdminModelConfig[], id: string) {
    return models.find((model) => model.id === id || model.modelId === id)?.name || id;
}

function toCsv(rows: Array<Record<string, string | number>>) {
    if (!rows.length) return "\uFEFF";
    const headers = Object.keys(rows[0] || {});
    const lines = rows.map((row) => headers.map((header) => csvCell(row[header])).join(","));
    return `\uFEFF${headers.join(",")}\n${lines.join("\n")}`;
}

function csvCell(value: string | number | undefined) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
}
