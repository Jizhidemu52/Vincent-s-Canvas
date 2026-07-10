import type { ReactNode } from "react";
import { Download, Edit3, FileUp, LogOut, ShieldCheck, SlidersHorizontal, UserPlus, UsersRound, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { App, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tabs, Tag, Typography, Upload } from "antd";
import { saveAs } from "file-saver";
import Papa from "papaparse";
import { Link, Navigate, useSearchParams } from "react-router-dom";

import { type AdminModelCapability, type AdminModelConfig, type AdminOperationType, type DesignerAccount, type PricingRule } from "@/lib/admin-domain";
import { ApiProviderPanel } from "@/pages/admin/components/api-provider-panel";
import { WorkflowManagementPanel } from "@/pages/admin/components/workflow-management-panel";
import { ModelPricingPanel } from "@/pages/admin/components/model-pricing-panel";
import { HistoryManagementPanel, TaskManagementPanel } from "@/pages/admin/components/task-history-panels";
import { AdminAssetsPanel } from "@/pages/admin/components/admin-assets-panel";
import { useAdminStore } from "@/stores/use-admin-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { adjustAccountCredits, bulkCreateAccounts, createAccount, createDepartment, listAccounts, listAuditLogs, listDepartments, resetAccountPassword, updateAccount, type AccountInput, type AuditLog, type Department } from "@/services/api/admin-accounts";
import type { ApiUser, ApiUserRole } from "@/services/api/auth";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

const operationOptions: Array<{ label: string; value: AdminOperationType }> = [
    { label: "生成一张图", value: "image_generation" },
    { label: "生成视频", value: "video_generation" },
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
    email?: string;
    employeeNo?: string;
    departmentId?: string;
    role: ApiUserRole;
    status: ApiUser["status"];
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
    const [accounts, setAccounts] = useState<ApiUser[]>([]);
    const [departments, setDepartments] = useState<Department[]>([]);
    const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
    const [departmentName, setDepartmentName] = useState("");
    const [departmentCode, setDepartmentCode] = useState("");
    const [accountsLoading, setAccountsLoading] = useState(true);
    const [historyDesigner, setHistoryDesigner] = useState<string>("all");
    const [historyModel, setHistoryModel] = useState<string>("all");
    const [historyOperation, setHistoryOperation] = useState<string>("all");
    const [assetDesigner, setAssetDesigner] = useState<string>("all");
    const [searchParams, setSearchParams] = useSearchParams();
    const state = useAdminStore();
    const signedInUser = useUserStore((store) => store.user);
    const projects = useCanvasStore((store) => store.projects);
    const assets = useAssetStore((store) => store.assets);
    const currentOperator = signedInUser;
    const isAdmin = signedInUser?.role === "super_admin";
    const canManageAccounts = isAdminRole(signedInUser?.role);

    const refreshAccounts = async () => {
        setAccountsLoading(true);
        try {
            const [accountResult, departmentResult, auditResult] = await Promise.all([listAccounts(), listDepartments(), listAuditLogs()]);
            setAccounts(accountResult.users);
            setDepartments(departmentResult.departments);
            setAuditLogs(auditResult.auditLogs);
        } catch (error) { message.error(error instanceof Error ? error.message : "账号数据加载失败"); }
        finally { setAccountsLoading(false); }
    };

    useEffect(() => { if (canManageAccounts) void refreshAccounts(); }, [canManageAccounts]);

    const designerOptions = accounts.map((designer) => ({
        label: `${designer.displayName}（${designer.role === "designer" ? "设计师" : "管理员"}）`,
        value: designer.id,
    }));

    const activeDesigner = accounts.find((designer) => designer.role === "designer");
    const totalRemaining = accounts.reduce((sum, designer) => sum + designer.creditBalance, 0);
    const totalUsed = accounts.reduce((sum, designer) => sum + Math.max(0, designer.creditLimit - designer.creditBalance), 0);
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

    const requestedAdminTab = searchParams.get("tab") || "accounts";
    const activeAdminTab = isAdmin ? requestedAdminTab : "accounts";
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
    ].filter((tab) => isAdmin || tab.key === "accounts");

    const submitCreditChange = async (values: CreditFormValues) => {
        try { await adjustAccountCredits(values.designerId, values.amount, values.reason || "管理员调整"); message.success("额度已调整"); await refreshAccounts(); }
        catch (error) { message.error(error instanceof Error ? error.message : "额度调整失败"); }
    };

    const submitLimitChange = async (values: LimitFormValues) => {
        try { await updateAccount(values.designerId, { creditLimit: values.quotaLimit }); message.success("额度上限已更新"); await refreshAccounts(); }
        catch (error) { message.error(error instanceof Error ? error.message : "额度上限更新失败"); }
    };

    const submitAccount = async (values: AccountFormValues) => {
        try {
            if (editingAccountId) {
                await updateAccount(editingAccountId, { displayName: values.name, email: values.email || null, employeeNo: values.employeeNo || null, departmentId: values.departmentId || null, role: values.role === "super_admin" ? undefined : values.role, status: values.status, creditLimit: values.quotaLimit });
                if (values.password) await resetAccountPassword(editingAccountId, values.password);
            } else {
                await createAccount({ username: values.loginName, displayName: values.name, email: values.email || null, employeeNo: values.employeeNo || null, departmentId: values.departmentId || null, password: values.password || "", role: values.role, creditBalance: values.quotaRemaining, creditLimit: values.quotaLimit });
            }
            message.success(editingAccountId ? "账号已更新，权限和额度会在重新校验会话后同步" : "账号已开通，首次登录必须修改密码");
            setEditingAccountId(null);
            accountForm.resetFields();
            accountForm.setFieldsValue({ role: "designer", status: "active", quotaRemaining: 500, quotaLimit: 500 });
            await refreshAccounts();
        } catch (error) { message.error(error instanceof Error ? error.message : "账号保存失败"); }
    };

    const editAccount = (designer: ApiUser) => {
        setEditingAccountId(designer.id);
        accountForm.setFieldsValue({
            loginName: designer.username,
            password: "",
            name: designer.displayName,
            email: designer.email || undefined,
            employeeNo: designer.employeeNo || undefined,
            departmentId: designer.departmentId || undefined,
            role: designer.role,
            status: designer.status,
            quotaRemaining: designer.creditBalance,
            quotaLimit: designer.creditLimit,
        });
    };

    const downloadAccountTemplate = () => {
        const csv = Papa.unparse([{ username: "zhangsan", displayName: "张三", email: "zhangsan@company.com", employeeNo: "D001", password: "Canvas2026Start", role: "designer", departmentCode: departments[0]?.code || "design", creditBalance: 500, creditLimit: 500 }]);
        saveAs(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), "设计师账号导入模板.csv");
    };

    const importAccountCsv = async (file: File) => {
        try {
            const parsed = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: true });
            const firstError = parsed.errors[0];
            if (firstError) throw new Error(`CSV 第 ${(firstError.row ?? 0) + 2} 行格式错误：${firstError.message}`);
            const accountsToCreate: AccountInput[] = parsed.data.map((row, index) => {
                const department = departments.find((item) => item.code.toLowerCase() === row.departmentCode?.trim().toLowerCase());
                if (!department) throw new Error(`CSV 第 ${index + 2} 行的部门编码不存在`);
                const role = row.role?.trim() === "department_admin" ? "department_admin" : "designer";
                return {
                    username: row.username?.trim(), displayName: row.displayName?.trim(), email: row.email?.trim() || null,
                    employeeNo: row.employeeNo?.trim() || null, password: row.password, role, departmentId: department.id,
                    creditBalance: Number(row.creditBalance || 0), creditLimit: Number(row.creditLimit || 0),
                };
            });
            const result = await bulkCreateAccounts(accountsToCreate);
            if (result.failures.length) message.warning(`成功导入 ${result.created} 人，失败 ${result.failures.length} 人；首条失败：${result.failures[0].message}`);
            else message.success(`成功导入 ${result.created} 个账号`);
            await refreshAccounts();
        } catch (error) { message.error(error instanceof Error ? error.message : "CSV 导入失败"); }
        return false;
    };

    const submitDepartment = async () => {
        if (!departmentName.trim() || !departmentCode.trim()) { message.warning("请输入部门名称和编码"); return; }
        try {
            await createDepartment(departmentName, departmentCode);
            setDepartmentName(""); setDepartmentCode("");
            message.success("部门已创建");
            await refreshAccounts();
        } catch (error) { message.error(error instanceof Error ? error.message : "部门创建失败"); }
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

    if (!signedInUser || !canManageAccounts) return <Navigate to="/admin/login" replace />;

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
                            当前管理员：<span className="font-medium">{currentOperator?.displayName}</span>
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
                    <Metric icon={<UsersRound className="size-4" />} label="可管理账号" value={String(accounts.length)} />
                    <Metric icon={<WalletCards className="size-4" />} label="剩余额度" value={totalRemaining.toLocaleString()} />
                    <Metric icon={<SlidersHorizontal className="size-4" />} label="已用额度" value={totalUsed.toLocaleString()} />
                    <Metric icon={<ShieldCheck className="size-4" />} label="人民币成本" value={`￥${totalCost.toFixed(2)}`} />
                </section>

                {!isAdmin ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
                        当前为部门管理员，只能管理本部门设计师账号和额度；模型、API 与全局价格仅超级管理员可配置。
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
                                            loading={accountsLoading}
                                            pagination={{ pageSize: 20, showSizeChanger: false }}
                                            dataSource={accounts}
                                            columns={[
                                                { title: "姓名", dataIndex: "displayName" },
                                                { title: "登录账号", dataIndex: "username" },
                                                { title: "部门", dataIndex: "departmentName", render: (value: string | null) => value || "未分配" },
                                                { title: "角色", render: (_, record: ApiUser) => <Tag color={record.role === "super_admin" ? "red" : record.role === "department_admin" ? "blue" : "default"}>{record.role === "super_admin" ? "超级管理员" : record.role === "department_admin" ? "部门管理员" : "设计师"}</Tag> },
                                                { title: "状态", render: (_, record: ApiUser) => <Tag color={record.status === "active" ? "green" : "red"}>{record.status === "active" ? "启用" : record.status === "locked" ? "锁定" : "停用"}</Tag> },
                                                { title: "剩余额度", dataIndex: "creditBalance", sorter: (a: ApiUser, b: ApiUser) => a.creditBalance - b.creditBalance },
                                                { title: "已用额度", render: (_, record: ApiUser) => Math.max(0, record.creditLimit - record.creditBalance) },
                                                { title: "额度上限", dataIndex: "creditLimit" },
                                                {
                                                    title: "操作",
                                                    render: (_, record: ApiUser) => (
                                                        <Button size="small" icon={<Edit3 className="size-3.5" />} onClick={() => editAccount(record)}>
                                                            编辑
                                                        </Button>
                                                    ),
                                                },
                                            ]}
                                        />
                                        <div className="grid gap-3">
                                            {isAdmin ? (
                                                <Panel title="部门管理">
                                                    <div className="grid grid-cols-2 gap-2">
                                                        <Input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} placeholder="部门名称" />
                                                        <Input value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)} placeholder="唯一编码" />
                                                    </div>
                                                    <Button className="mt-2" block onClick={submitDepartment}>新建部门</Button>
                                                </Panel>
                                            ) : null}
                                            <Panel title={editingAccountId ? "编辑账号权限" : "开通设计师账号"}>
                                                <div className="mb-4 flex flex-wrap gap-2">
                                                    <Upload accept=".csv,text/csv" maxCount={1} showUploadList={false} beforeUpload={(file) => importAccountCsv(file as File)}>
                                                        <Button icon={<FileUp className="size-4" />}>批量导入 CSV</Button>
                                                    </Upload>
                                                    <Button icon={<Download className="size-4" />} onClick={downloadAccountTemplate}>下载模板</Button>
                                                </div>
                                                <Form form={accountForm} layout="vertical" disabled={!canManageAccounts} initialValues={{ role: "designer", status: "active", quotaRemaining: 500, quotaLimit: 500 }} onFinish={submitAccount}>
                                                    <Form.Item name="loginName" label="登录账号" rules={[{ required: true, message: "请输入登录账号" }]}>
                                                        <Input placeholder="例如：张三 / zhangsan / 邮箱 / 工号" disabled={Boolean(editingAccountId)} />
                                                    </Form.Item>
                                                    <Form.Item name="password" label={editingAccountId ? "新密码（留空不改）" : "初始密码"} rules={editingAccountId ? [] : [{ required: true, message: "请设置初始密码" }]}>
                                                        <Input.Password placeholder={editingAccountId ? "留空则保持原密码" : "给设计师的初始密码"} />
                                                    </Form.Item>
                                                    <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
                                                        <Input placeholder="设计师姓名" />
                                                    </Form.Item>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <Form.Item name="email" label="邮箱"><Input placeholder="可用于登录" /></Form.Item>
                                                        <Form.Item name="employeeNo" label="工号"><Input placeholder="可用于登录" /></Form.Item>
                                                    </div>
                                                    <Form.Item name="departmentId" label="所属部门" rules={[{ required: true, message: "请选择部门" }]}>
                                                        <Select options={departments.map((department) => ({ label: department.name, value: department.id }))} />
                                                    </Form.Item>
                                                    <Form.Item name="role" label="角色" rules={[{ required: true }]}>
                                                        <Select
                                                            options={[
                                                                { label: "普通设计师", value: "designer" },
                                                                ...(isAdmin ? [{ label: "部门管理员", value: "department_admin" }] : []),
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
                                                <Typography.Paragraph className="!mb-0 !mt-3 text-xs !text-stone-500">登录账号支持中文或英文，邮箱和工号也可登录。新账号首次登录必须修改密码；停用和重置密码会使既有会话失效。</Typography.Paragraph>
                                            </Panel>
                                            <Panel title="调整额度">
                                                <Form form={creditForm} layout="vertical" disabled={!canManageAccounts} initialValues={{ designerId: activeDesigner?.id, amount: 100, reason: "项目补充额度" }} onFinish={submitCreditChange}>
                                                    <Form.Item name="designerId" label="设计师" rules={[{ required: true }]}>
                                                        <Select options={designerOptions.filter((item) => accounts.find((designer) => designer.id === item.value)?.role === "designer")} />
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
                                                <Form form={limitForm} layout="vertical" disabled={!canManageAccounts} initialValues={{ designerId: activeDesigner?.id, quotaLimit: activeDesigner?.creditLimit || 500 }} onFinish={submitLimitChange}>
                                                    <Form.Item name="designerId" label="设计师" rules={[{ required: true }]}>
                                                        <Select options={designerOptions.filter((item) => accounts.find((designer) => designer.id === item.value)?.role === "designer")} />
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
                                children: <ModelPricingPanel mode="prices" />,
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
                                children: <ModelPricingPanel mode="models" />,
                            },
                            {
                                key: "history",
                                label: "历史记录",
                                children: <HistoryManagementPanel />,
                            },
                            {
                                key: "projects",
                                label: "项目素材",
                                children: <AdminAssetsPanel />,
                            },
                            {
                                key: "batch",
                                label: "批量任务",
                                children: <TaskManagementPanel />,
                            },
                            {
                                key: "audit",
                                label: "审计日志",
                                children: (
                                    <Table
                                        rowKey="id"
                                        size="small"
                                        dataSource={auditLogs}
                                        columns={[
                                            { title: "时间", dataIndex: "createdAt", width: 180 },
                                            { title: "操作人", dataIndex: "actorName", render: (value: string | null) => value || "系统" },
                                            { title: "部门", dataIndex: "departmentName", render: (value: string | null) => value || "全局" },
                                            { title: "目标", dataIndex: "targetId" },
                                            { title: "行为", dataIndex: "action" },
                                            { title: "内容", dataIndex: "detail", ellipsis: true, render: (value: Record<string, unknown>) => JSON.stringify(value) },
                                            { title: "结果", render: (_, record) => <Tag color={record.result === "success" ? "green" : "red"}>{record.result === "success" ? "成功" : "失败"}</Tag> },
                                        ]}
                                    />
                                ),
                            },
                        ]}
                    />
                </div>

                <div className="rounded-md border border-stone-200 bg-white px-4 py-3 text-xs leading-5 text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
                    账号、会话、模型密钥、价格版本、额度账本、任务队列、生成历史和管理审计已由服务端统一管理。公司对象存储与素材同步将在下一阶段接入。
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
