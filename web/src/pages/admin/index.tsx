import { displayNotice, useDisplayUiValue, useDisplayConfig  } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import type { ReactNode } from "react";
import { Download, Edit3, FileUp, LogOut, RefreshCw, UserPlus, UsersRound } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Form, Input, Select, Skeleton, Space, Table, Tabs, Tag, Typography, Upload } from "antd";
import { saveAs } from "file-saver";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { bulkCreateAccounts, createAccount, createDepartment, resetAccountPassword, updateAccount, type AuditLog, type Department } from "@/services/api/admin-accounts";
import { loadAdminOverview, markPlatformAdminTabLabel, resolveAdminTab } from "./admin-overview";
import { accountTemplateCsv, parseAccountCsv, prepareNewAccount } from "./account-input";
import { getAuthMethods, type ApiUser, type ApiUserRole } from "@/services/api/auth";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { useModuleStore } from "@/stores/use-module-store";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useUnsavedGuard, useConfirmUnsavedChanges } from "@/hooks/use-unsaved-guard";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { isFinancialAuditAction } from "@/lib/financial-presentation";
import { AdminDetails, adminLabel } from "./admin-labels";
import { filterAdminAccounts } from "./account-ux";

const ApiConfigurationHub = lazy(() => import("./components/api-configuration-hub").then((module) => ({ default: module.ApiConfigurationHub })));
const MarkImageProviderPanel = lazy(() => import("./components/mark-image-provider-panel").then((module) => ({ default: module.MarkImageProviderPanel })));
const UsageAnalyticsPanel = lazy(() => import("./components/usage-analytics-panel").then((module) => ({ default: module.UsageAnalyticsPanel })));
const HistoryManagementPanel = lazy(() => import("./components/task-history-panels").then((module) => ({ default: module.HistoryManagementPanel })));
const TaskManagementPanel = lazy(() => import("./components/task-history-panels").then((module) => ({ default: module.TaskManagementPanel })));
const AdminAssetsPanel = lazy(() => import("./components/admin-assets-panel").then((module) => ({ default: module.AdminAssetsPanel })));
const IntegrationStatusPanel = lazy(() => import("./components/integration-status-panel").then((module) => ({ default: module.IntegrationStatusPanel })));
const GroupManagementPanel = lazy(() => import("./components/group-management-panel").then((module) => ({ default: module.GroupManagementPanel })));
const ModuleSwitchPanel = lazy(() => import("./components/module-switch-panel").then((module) => ({ default: module.ModuleSwitchPanel })));
const PerformanceDashboard = lazy(() => import("@/pages/performance/dashboard").then((module) => ({ default: module.PerformanceDashboard })));
const ReleaseNotesPanel = lazy(() => import("./release-notes"));

type AccountFormValues = {
    loginName: string;
    password?: string;
    name: string;
    email?: string;
    employeeNo?: string;
    departmentId?: string;
    role: ApiUserRole;
    status: ApiUser["status"];
};

export default function AdminPage() {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
    const { message, modal } = App.useApp();
    const [accountDirty, setAccountDirty] = useState(false);
    const [accountSearch, setAccountSearch] = useState("");
    const [accountStatus, setAccountStatus] = useState("");
    const [accountDepartment, setAccountDepartment] = useState("");
    const accountEditorRef = useRef<HTMLDivElement>(null);
    const confirmAllUnsaved = useConfirmUnsavedChanges();
    const [accountForm] = Form.useForm<AccountFormValues>();
    const accountRole = Form.useWatch("role", accountForm) ?? "designer";
    const navigate = useNavigate();
    const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
    const [wecomEnabled, setWecomEnabled] = useState(false);
    const passwordlessAccount = wecomEnabled && !editingAccountId && accountRole === "designer";
    const [accounts, setAccounts] = useState<ApiUser[]>([]);
    const [departments, setDepartments] = useState<Department[]>([]);
    const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
    const [departmentName, setDepartmentName] = useState("");
    const [departmentCode, setDepartmentCode] = useState("");
    const { confirmDiscard: confirmAccountDiscard } = useUnsavedGuard(accountDirty, staticUiText("账号表单尚未保存，离开后将丢失本次修改。"));
    useUnsavedGuard(Boolean(departmentName || departmentCode), staticUiText("部门表单尚未保存，离开后将丢失本次修改。"));
    const [accountsLoading, setAccountsLoading] = useState(true);
    const [accountsReady, setAccountsReady] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [pendingAction, setPendingAction] = useState("");
    const pendingActionRef = useRef("");
    const accountsRequest = useRef(0);
    const [searchParams, setSearchParams] = useSearchParams();
    const signedInUser = useUserStore((store) => store.user);
    const hydrateSession = useUserStore((store) => store.hydrateSession);
    const performanceEnabled = useModuleStore((store) => store.flags.performance);
    const clearSession = useUserStore((store) => store.clearSession);
    const currentOperator = signedInUser;
    const isAdmin = signedInUser?.role === "super_admin";
    const canManageAccounts = isAdminRole(signedInUser?.role);
    const departmentAdminTabs = new Set(["accounts", "groups", "performance"]);
    const activeAdminTab = resolveAdminTab(searchParams.get("tab"), isAdmin, performanceEnabled);

    const refreshAccounts = async () => {
        const request = ++accountsRequest.current;
        setAccountsLoading(true);
        try {
            const result = await loadAdminOverview();
            if (request !== accountsRequest.current) return;
            if (result.accounts) { setAccounts(result.accounts); setAccountsReady(true); }
            if (result.departments) setDepartments(result.departments);
            if (result.auditLogs) setAuditLogs(result.auditLogs);
            setLoadError(result.errors.join("；"));
        } catch (error) { if (request === accountsRequest.current) setLoadError(error instanceof Error ? error.message : "账号数据加载失败"); }
        finally { if (request === accountsRequest.current) setAccountsLoading(false); }
    };

    useEffect(() => {
        setAccounts([]); setDepartments([]); setAuditLogs([]); setAccountsReady(false);
        if (canManageAccounts) void refreshAccounts();
        return () => { accountsRequest.current++; };
    }, [canManageAccounts, signedInUser?.id, signedInUser?.role, signedInUser?.departmentId]);

    useEffect(() => {
        let active = true;
        setWecomEnabled(false);
        if (canManageAccounts) void getAuthMethods()
            .then((methods) => { if (active) setWecomEnabled(methods.wecom === true); })
            .catch(() => { if (active) setWecomEnabled(false); });
        return () => { active = false; };
    }, [canManageAccounts, signedInUser?.id]);

    const runAction = async (key: string, action: () => Promise<void>) => {
        if (pendingActionRef.current) return;
        pendingActionRef.current = key; setPendingAction(key);
        try { await action(); }
        finally { pendingActionRef.current = ""; setPendingAction(""); }
    };

    useEffect(() => {
        if (activeAdminTab === "accounts") return;
        accountForm.resetFields();
        setEditingAccountId(null); setAccountDirty(false);
        setDepartmentName(""); setDepartmentCode("");
    }, [activeAdminTab, accountForm]);
    const filteredAccounts = filterAdminAccounts(accounts, accountSearch, accountStatus, accountDepartment);

    const changeAdminTab = (tab: string) => {
        setSearchParams(tab === "accounts" ? {} : { tab }, { replace: true });
    };
    const adminTabOptions = [
        { key: "accounts", label: "账号管理" },
        { key: "groups", label: "设计师分组" },
        ...(performanceEnabled ? [{ key: "performance", label: "设计效能" }] : []),
        { key: "modules", label: "模块开关" },
        { key: "api", label: "板块 API 配置" },
        { key: "usage-analysis", label: "使用分析" },
        { key: "mark-images", label: markPlatformAdminTabLabel },
        { key: "history", label: "历史记录" },
        { key: "projects", label: "项目素材" },
        { key: "batch", label: "批量任务" },
        { key: "audit", label: "审计日志" },
        { key: "integrations", label: "系统集成" },
        { key: "release-notes", label: "版本更新" },
    ].filter((tab) => isAdmin || departmentAdminTabs.has(tab.key));

    const submitAccount = async (values: AccountFormValues) => {
        const account = accounts.find((item) => item.id === editingAccountId);
        const changes = [values.status === "disabled" ? "停用后该账号无法继续使用，既有会话失效。" : "账号状态：启用。", values.password && editingAccountId ? "同时重置密码，既有会话失效。" : ""].filter(Boolean).join(" ");
        if (!await modal.confirm({ title: staticUiText("{p0}账号 {p1}？", { p0: `${editingAccountId ? staticUiText("确认保存") : staticUiText("确认开通")}`, p1: `${account?.displayName || values.name}` }), content: staticUiText("登录账号：{p0}。{p1}", { p0: `${account?.username || values.loginName}`, p1: `${changes}` }), okText: staticUiText("确认保存"), cancelText: staticUiText("返回核对"), okButtonProps: { danger: values.status === "disabled" } })) return;
        return runAction("account", async () => {
        try {
            if (editingAccountId) {
                const currentAccount = accounts.find((account) => account.id === editingAccountId);
                if (!currentAccount) throw new Error("账号不存在或已更新，请刷新后重试");
                await updateAccount(editingAccountId, { displayName: values.name, email: values.email || null, employeeNo: values.employeeNo || null, departmentId: values.departmentId || null, role: values.role === "super_admin" ? undefined : values.role, status: values.status });
                if (values.password) await resetAccountPassword(editingAccountId, values.password);
                if (editingAccountId === signedInUser?.id) await hydrateSession();
            } else {
                await createAccount(prepareNewAccount({ username: values.loginName, displayName: values.name, email: values.email || null, employeeNo: values.employeeNo || null, departmentId: values.departmentId || null, password: values.password, role: values.role, status: values.status === "disabled" ? "disabled" : "active", creditBalance: 500, creditLimit: 500, monthlyCreditLimit: 500 }, wecomEnabled));
            }
            message.success(displayNotice(editingAccountId ? staticUiText("账号已更新") : wecomEnabled && values.role === "designer" ? staticUiText("账号已开通，可直接使用企业微信扫码登录") : staticUiText("账号已开通，首次登录必须修改密码")));
            setEditingAccountId(null);
            setAccountDirty(false);
            accountForm.resetFields();
            accountForm.setFieldsValue({ role: "designer", status: "active" });
            await refreshAccounts();
        } catch (error) { message.error(displayNotice(error instanceof Error ? error.message : staticUiText("账号保存失败"))); }
        });
    };

    const editAccount = async (designer: ApiUser) => {
        if (pendingActionRef.current) return;
        if (!await confirmAccountDiscard()) return;
        setAccountDirty(false);
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
        });
        accountEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        accountEditorRef.current?.focus({ preventScroll: true });
    };

    const downloadAccountTemplate = () => {
        const csv = accountTemplateCsv(departments, wecomEnabled);
        saveAs(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), "设计师账号导入模板.csv");
    };

    const importAccountCsv = async (file: File) => {
        await runAction("import", async () => {
        try {
            const accountsToCreate = parseAccountCsv(await file.text(), departments, wecomEnabled);
            const result = await bulkCreateAccounts(accountsToCreate);
            if (result.failures.length) message.warning(displayNotice(staticUiText("成功导入 {p0} 人，失败 {p1} 人；首条失败：{p2}", { p0: `${result.created}`, p1: `${result.failures.length}`, p2: `${result.failures[0].message}` })));
            else message.success(displayNotice(staticUiText("成功导入 {p0} 个账号", { p0: `${result.created}` })));
            await refreshAccounts();
        } catch (error) { message.error(displayNotice(error instanceof Error ? error.message : staticUiText("CSV 导入失败"))); }
        });
        return false;
    };

    const submitDepartment = async () => {
        if (!departmentName.trim() || !departmentCode.trim()) { message.warning(staticUiText("请输入部门名称和编码")); return; }
        await runAction("department", async () => {
        try {
            await createDepartment(departmentName, departmentCode);
            setDepartmentName(""); setDepartmentCode("");
            message.success(staticUiText("部门已创建"));
            await refreshAccounts();
        } catch (error) { message.error(displayNotice(error instanceof Error ? error.message : staticUiText("部门创建失败"))); }
        });
    };

    if (!signedInUser || !canManageAccounts) return <Navigate to="/admin/login" replace />;

    return (
        <div className="wb-page h-full overflow-y-auto">
            <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
                <section className="wb-header !mb-0">
                    <div>
                        <div className="wb-eyebrow">{staticUiText("管理工作台")}</div>
                        <h1 className="wb-title">{staticUiText("管理中心")}</h1>
                        <p className="wb-description">{staticUiText("统一管理成员、生成服务与使用记录。只显示当前账号可管理的范围。")}</p>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        {signedInUser.role === "super_admin" && <Link to="/"><Button className="!h-10">{staticUiText("进入个人工作台")}</Button></Link>}
                        <div className="text-sm text-[var(--muted-foreground)]">{staticUiText("当前管理员：")}<span className="font-medium">{displayUi(currentOperator?.displayName)}</span>
                        </div>
                        <Button className="!h-10" icon={<RefreshCw className="size-4" />} loading={accountsLoading} onClick={() => void refreshAccounts()}>{staticUiText("刷新概览")}</Button>
                        <Button
                            className="!h-10"
                            loading={pendingAction === "logout"}
                            disabled={Boolean(pendingAction) && pendingAction !== "logout"}
                            icon={<LogOut className="size-4" />}
                            onClick={() => void runAction("logout", async () => {
                                if (!await confirmAllUnsaved()) return;
                                await clearSession();
                                navigate("/admin/login", { replace: true });
                            }).catch((error) => message.error(displayNotice(error instanceof Error ? error.message : staticUiText("退出失败，请重试"))))}
                        >{staticUiText("退出")}</Button>
                    </div>
                </section>

                <section className="w-full max-w-sm" aria-label={staticUiText("管理概览")} aria-busy={accountsLoading}>
                    <Metric icon={<UsersRound className="size-4" />} label={staticUiText("可管理账号")} value={accountsReady ? String(accounts.length) : "—"} />
                </section>
                {loadError ? <Alert type="warning" showIcon title={staticUiText("部分概览暂未更新")} description={displayUi(loadError)} action={<Button loading={accountsLoading} onClick={() => void refreshAccounts()}>{staticUiText("重试")}</Button>} /> : null}

                {!isAdmin ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">{staticUiText("当前为部门管理员，只能管理本部门设计师账号；模型与 API 仅超级管理员可配置。")}</div>
                ) : null}

                <div className="grid min-w-0 gap-5 lg:grid-cols-[180px_minmax(0,1fr)]">
                <nav aria-label={staticUiText("管理板块")} className="wb-surface flex gap-4 overflow-x-auto p-3 lg:sticky lg:top-3 lg:block lg:self-start">
                    {[
                        { label: "成员管理", keys: ["accounts", "groups", "performance"] },
                        { label: "模型与服务", keys: ["api", "mark-images"] },
                        { label: "内容", keys: ["projects", "history", "release-notes"] },
                        { label: "运维", keys: ["modules", "usage-analysis", "batch", "audit", "integrations"] },
                    ].map((group) => {
                        const tabs = adminTabOptions.filter((tab) => group.keys.includes(tab.key));
                        if (!tabs.length) return null;
                        return <section key={group.label} className="min-w-[145px] lg:mb-4 lg:last:mb-0">
                            <h2 className="mb-1 px-3 text-xs font-medium text-[var(--muted-foreground)]">{staticUiText(group.label)}</h2>
                            {tabs.map((tab) => <Link key={tab.key} to={tab.key === "accounts" ? "/admin" : `/admin?tab=${tab.key}`} aria-current={activeAdminTab === tab.key ? "page" : undefined} className="wb-nav-link block rounded-xl px-3 py-2">{staticUiText(tab.label)}</Link>)}
                            {group.label === "内容" && isAdmin ? <><Link className="wb-nav-link block rounded-xl px-3 py-2" to="/admin/prompt-recipes">{staticUiText("提示词配方")}</Link>{deploymentFeatures.oaLoginEnabled ? <Link className="wb-nav-link block rounded-xl px-3 py-2" to="/admin/design-library">{staticUiText("设计灵感库管理")}</Link> : null}</> : null}
                        </section>;
                    })}
                </nav>

                <div className="min-w-0">
                    <Suspense fallback={<div className="wb-surface p-6" role="status" aria-label={staticUiText("正在加载管理板块")}><Skeleton active paragraph={{ rows: 5 }} /></div>}>
                    <Tabs
                        className="admin-tabs"
                        activeKey={activeAdminTab}
                        onChange={changeAdminTab}
                        onTabClick={changeAdminTab}
                        renderTabBar={() => <></>}
                        destroyOnHidden
                        items={[
                            {
                                key: "accounts",
                                label: staticUiText("账号管理"),
                                children: (
                                    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                                        <div className="min-w-0">
                                        <div className="wb-toolbar mb-3">
                                            <Input className="!w-full sm:!w-64" aria-label={staticUiText("搜索账号")} placeholder={staticUiText("姓名、账号、邮箱或工号")} allowClear value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} />
                                            <Select className="!w-32" aria-label={staticUiText("账号状态筛选")} placeholder={staticUiText("全部状态")} allowClear value={accountStatus || undefined} onChange={(value) => setAccountStatus(value || "")} options={displayConfig([{ value: "active", label: staticUiText("启用") }, { value: "disabled", label: staticUiText("停用") }, { value: "locked", label: staticUiText("锁定") }], "options")} />
                                            <Select className="!w-40" aria-label={staticUiText("账号部门筛选")} placeholder={staticUiText("全部部门")} allowClear value={accountDepartment || undefined} onChange={(value) => setAccountDepartment(value || "")} options={displayConfig(departments.map((department) => ({ value: department.id, label: department.name })), "options")} />
                                            <span className="text-xs text-[var(--muted-foreground)]">{filteredAccounts.length}{staticUiText(" 个账号")}</span>
                                        </div>
                                        <Table
                                            className="wb-surface min-w-0 overflow-hidden"
                                            rowKey="id"
                                            size="small"
                                            loading={accountsLoading}
                                            pagination={{ pageSize: 20, showSizeChanger: false }}
                                            dataSource={filteredAccounts}
                                            onRow={(record) => ({ "aria-selected": record.id === editingAccountId, style: record.id === editingAccountId ? { background: "var(--accent)", outline: "2px solid var(--primary)", outlineOffset: -2 } : undefined })}
                                            scroll={{ x: 720 }}
                                            locale={{ emptyText: loadError && !accountsReady ? staticUiText("账号尚未加载，请在上方重试") : staticUiText("暂无可管理账号") }}
                                            columns={displayConfig([
                                                { title: staticUiText("姓名"), dataIndex: "displayName" },
                                                { title: staticUiText("登录账号"), dataIndex: "username" },
                                                { title: staticUiText("部门"), dataIndex: "departmentName", render: (value: string | null) => value || staticUiText("未分配") },
                                                { title: staticUiText("角色"), render: (_, record: ApiUser) => <Tag color={record.role === "super_admin" ? "red" : record.role === "department_admin" ? "blue" : "default"}>{record.role === "super_admin" ? staticUiText("超级管理员") : record.role === "department_admin" ? staticUiText("部门管理员") : staticUiText("设计师")}</Tag> },
                                                { title: staticUiText("状态"), render: (_, record: ApiUser) => <Tag color={record.status === "active" ? "green" : "red"}>{record.status === "active" ? staticUiText("启用") : record.status === "locked" ? staticUiText("锁定") : staticUiText("停用")}</Tag> },
                                                {
                                                    title: staticUiText("操作"),
                                                    render: (_, record: ApiUser) => (
                                                        <Button size="small" disabled={Boolean(pendingAction)} icon={<Edit3 className="size-3.5" />} onClick={() => editAccount(record)}>{staticUiText("编辑")}</Button>
                                                    ),
                                                },
                                            ], "columns", filteredAccounts)}
                                        />
                                        </div>
                                        <div className="grid gap-3">
                                            {isAdmin ? (
                                                <Panel title={staticUiText("部门管理")}>
                                                    <div className="grid grid-cols-2 gap-2">
                                                        <Input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} placeholder={staticUiText("部门名称")} />
                                                        <Input value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)} placeholder={staticUiText("唯一编码")} />
                                                    </div>
                                                    <Button className="mt-3 !h-10" loading={pendingAction === "department"} disabled={Boolean(pendingAction) && pendingAction !== "department"} block onClick={submitDepartment}>{staticUiText("新建部门")}</Button>
                                                </Panel>
                                            ) : null}
                                            <div ref={accountEditorRef} tabIndex={-1} className="scroll-mt-4 outline-none" aria-label={editingAccountId ? staticUiText("正在编辑账号") : staticUiText("开通设计师账号")}>
                                            <Panel title={editingAccountId ? staticUiText("编辑账号：{p0}", { p0: `${accounts.find((item) => item.id === editingAccountId)?.displayName || ""}` }) : staticUiText("开通设计师账号")}>
                                                <div className="mb-4 flex flex-wrap gap-2">
                                                    <Upload accept=".csv,text/csv" disabled={Boolean(pendingAction)} maxCount={1} showUploadList={false} beforeUpload={(file) => importAccountCsv(file as File)}>
                                                        <Button loading={pendingAction === "import"} disabled={Boolean(pendingAction) && pendingAction !== "import"} icon={<FileUp className="size-4" />}>{staticUiText("批量导入 CSV")}</Button>
                                                    </Upload>
                                                    <Button icon={<Download className="size-4" />} onClick={downloadAccountTemplate}>{staticUiText("下载模板")}</Button>
                                                </div>
                                                 <Form name="admin-account" form={accountForm} layout="vertical" onValuesChange={() => setAccountDirty(true)} disabled={!canManageAccounts || Boolean(pendingAction)} initialValues={{ role: "designer", status: "active" }} onFinish={submitAccount}>
                                                    <Form.Item name="loginName" label={staticUiText("登录账号")} rules={[{ required: true, message: staticUiText("请输入登录账号") }]}>
                                                        <Input placeholder={staticUiText("例如：张三 / zhangsan / 邮箱 / 工号")} disabled={Boolean(editingAccountId)} />
                                                    </Form.Item>
                                                    {!passwordlessAccount && <Form.Item name="password" preserve={false} label={editingAccountId ? staticUiText("新密码（留空不改）") : staticUiText("初始密码")} rules={editingAccountId ? [] : [{ required: true, message: staticUiText("请设置初始密码") }, { min: 12, max: 200, message: staticUiText("密码需为 12 至 200 位") }, { pattern: /^(?=.*[A-Za-z])(?=.*\d)[\s\S]+$/, message: staticUiText("密码必须同时包含字母和数字") }]}>
                                                        <Input.Password placeholder={editingAccountId ? staticUiText("留空则保持原密码") : staticUiText("至少 12 位，包含字母和数字")} />
                                                    </Form.Item>}
                                                    <Form.Item name="name" label={staticUiText("姓名")} rules={[{ required: true, message: staticUiText("请输入姓名") }]}>
                                                        <Input placeholder={staticUiText("设计师姓名")} />
                                                    </Form.Item>
                                                     <div className="grid grid-cols-2 gap-3">
                                                        <Form.Item name="email" label={staticUiText("邮箱")}><Input placeholder={staticUiText("可用于登录")} /></Form.Item>
                                                        <Form.Item name="employeeNo" label={passwordlessAccount ? staticUiText("企业微信成员账号") : staticUiText("工号")} rules={passwordlessAccount ? [{ required: true, whitespace: true, message: staticUiText("请输入企业微信成员账号") }] : []} extra={passwordlessAccount ? staticUiText("须与企业微信通讯录中的成员账号一致，不是姓名或昵称。") : undefined}><Input placeholder={passwordlessAccount ? staticUiText("企业微信通讯录成员账号") : staticUiText("可用于登录")} /></Form.Item>
                                                     </div>
                                                    <Form.Item name="departmentId" label={staticUiText("所属部门")} dependencies={["role"]} extra={isAdmin ? staticUiText("设计师可不分配部门；部门管理员必须指定部门。") : undefined} rules={[({ getFieldValue }) => ({ required: !isAdmin || getFieldValue("role") === "department_admin", message: staticUiText("请选择部门") })]}>
                                                        <Select allowClear={isAdmin} options={displayConfig(departments.map((department) => ({ label: department.name, value: department.id })), "options")} />
                                                    </Form.Item>
                                                    <Form.Item name="role" label={staticUiText("角色")} rules={[{ required: true }]}>
                                                        <Select
                                                            options={displayConfig([
                                                                { label: staticUiText("普通设计师"), value: "designer" },
                                                                ...(isAdmin ? [{ label: staticUiText("部门管理员"), value: "department_admin" }] : []),
                                                            ], "options")}
                                                        />
                                                    </Form.Item>
                                                    <Form.Item name="status" label={staticUiText("状态")} rules={[{ required: true }]}>
                                                        <Select
                                                            options={displayConfig([
                                                                { label: staticUiText("启用"), value: "active" },
                                                                { label: staticUiText("停用"), value: "disabled" },
                                                            ], "options")}
                                                        />
                                                    </Form.Item>
                                                    <Space className="w-full" orientation="vertical">
                                                        <Button className="!h-10" loading={pendingAction === "account"} type="primary" htmlType="submit" icon={<UserPlus className="size-4" />} block>
                                                            {editingAccountId ? staticUiText("保存账号") : staticUiText("开通账号")}
                                                        </Button>
                                                        {editingAccountId ? (
                                                            <Button
                                                                block
                                                                onClick={async () => {
                                                                    if (!await confirmAccountDiscard()) return;
                                                                    setAccountDirty(false);
                                                                    setEditingAccountId(null);
                                                                    accountForm.resetFields();
                                                                     accountForm.setFieldsValue({ role: "designer", status: "active" });
                                                                }}
                                                            >{staticUiText("取消编辑")}</Button>
                                                        ) : null}
                                                    </Space>
                                                </Form>
                                                <Typography.Paragraph className="!mb-0 !mt-3 text-xs !text-stone-500">{wecomEnabled ? staticUiText("新设计师无需初始密码，填写企业微信成员账号后即可扫码登录。CSV 每批最多 200 人，设计师可不填写部门，旧模板中的设计师密码不会导入；部门管理员仍需设置初始密码。停用和重置密码会使既有会话失效。") : staticUiText("登录账号支持中文或英文，邮箱和工号也可登录。新账号首次登录必须修改密码；停用和重置密码会使既有会话失效。CSV 每批最多 200 人。")}</Typography.Paragraph>
                                            </Panel>
                                            </div>
                                        </div>
                                    </div>
                                ),
                            },
                            {
                                key: "groups",
                                label: staticUiText("设计师分组"),
                                children: <GroupManagementPanel accounts={accounts} departments={isAdmin ? departments : departments.filter((department) => department.id === signedInUser.departmentId)} />,
                            },
                            {
                                key: "performance",
                                label: staticUiText("设计效能"),
                                children: performanceEnabled ? <PerformanceDashboard /> : null,
                            },
                            {
                                key: "modules",
                                label: staticUiText("模块开关"),
                                children: <ModuleSwitchPanel />,
                            },
                            {
                                key: "api",
                                label: staticUiText("板块 API 配置"),
                                children: <ApiConfigurationHub isAdmin={isAdmin} />,
                            },
                            {
                                key: "usage-analysis",
                                label: staticUiText("使用分析"),
                                children: isAdmin ? (deploymentFeatures.authenticationEnabled ? <UsageAnalyticsPanel /> : <Alert type="info" showIcon title={staticUiText("使用分析需要启用账号登录")} description={staticUiText("免登录试用只保留本机常用板块，不采集人员使用记录。企业微信、独立账号或 OA 登录模式均支持使用分析。")} />) : null,
                            },
                            {
                                key: "mark-images",
                                label: staticUiText(markPlatformAdminTabLabel),
                                children: isAdmin ? <MarkImageProviderPanel /> : null,
                            },
                            {
                                key: "history",
                                label: staticUiText("历史记录"),
                                children: <HistoryManagementPanel />,
                            },
                            {
                                key: "projects",
                                label: staticUiText("项目素材"),
                                children: <AdminAssetsPanel />,
                            },
                            {
                                key: "batch",
                                label: staticUiText("批量任务"),
                                children: <TaskManagementPanel active={activeAdminTab === "batch"} />,
                            },
                            {
                                key: "audit",
                                label: staticUiText("审计日志"),
                                children: (
                                    <Table
                                        className="wb-surface overflow-hidden"
                                        loading={accountsLoading}
                                        scroll={{ x: 1000 }}
                                        rowKey="id"
                                        size="small"
                                        dataSource={auditLogs.filter(log => !isFinancialAuditAction(log.action))}
                                        columns={displayConfig([
                                            { title: staticUiText("时间（北京时间）"), dataIndex: "createdAt", width: 180, render: (value: string) => formatBeijingDateTime(value) },
                                            { title: staticUiText("操作人"), dataIndex: "actorName", render: (value: string | null) => value || staticUiText("系统") },
                                            { title: staticUiText("部门"), dataIndex: "departmentName", render: (value: string | null) => value || staticUiText("全局") },
                                            { title: staticUiText("目标"), dataIndex: "targetId" },
                                            { title: staticUiText("行为"), dataIndex: "action", render: adminLabel },
                                            { title: staticUiText("内容"), dataIndex: "detail", render: (value: Record<string, unknown>) => <details><summary className="cursor-pointer">{staticUiText("查看内容")}</summary><AdminDetails value={value} audit /></details> },
                                            { title: staticUiText("结果"), render: (_, record) => <Tag color={record.result === "success" ? "green" : "red"}>{record.result === "success" ? staticUiText("成功") : staticUiText("失败")}</Tag> },
                                        ], "columns", auditLogs.filter(log => !isFinancialAuditAction(log.action)))}
                                    />
                                ),
                            },
                            {
                                key: "release-notes",
                                label: staticUiText("版本更新"),
                                children: isAdmin ? <ReleaseNotesPanel /> : null,
                            },
                            {
                                key: "integrations",
                                label: staticUiText("系统集成"),
                                children: <IntegrationStatusPanel />,
                            },
                        ]}
                    />
                    </Suspense>
                </div>
                </div>

                <div className="text-xs leading-6 text-[var(--muted-foreground)]">{staticUiText("账号、会话、模型密钥、任务队列、公司对象存储、生成历史和管理审计均由服务端统一管理。")}</div>
            </main>
        </div>
    );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
    const displayUi = useDisplayUiValue();
    return (
        <div className="wb-surface px-5 py-4">
            <div className="flex items-center gap-2 text-xs font-medium text-[var(--muted-foreground)]">
                {icon}
                {displayUi(label)}
            </div>
            <div className="mt-3 text-[28px] font-semibold tracking-tight tabular-nums">{value}</div>
        </div>
    );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
    const displayUi = useDisplayUiValue();
    return (
        <section className="wb-surface p-5">
            <Typography.Title level={3} className="!mb-4 !text-base">
                {displayUi(title)}
            </Typography.Title>
            {children}
        </section>
    );
}
