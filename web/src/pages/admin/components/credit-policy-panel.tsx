import { Alert, App, Button, Skeleton, Switch } from "antd";
import { useEffect, useRef, useState } from "react";

import { loadDeploymentFeatures } from "@/lib/deployment-features";
import { getCreditPolicy, saveCreditPolicy, type CreditPolicy } from "@/services/api/credit-policy";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

export function CreditPolicyPanel() {
    const { modal } = App.useApp();
    const user = useUserStore((store) => store.user);
    const [policy, setPolicy] = useState<CreditPolicy | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const request = useRef<AbortController | null>(null);
    const writing = useRef(false);
    const confirming = useRef(false);
    const canRead = isAdminRole(user?.role);
    const canWrite = user?.role === "super_admin";

    const refresh = async () => {
        if (!canRead || writing.current) return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true); setError(""); setNotice(""); setPolicy(null);
        try {
            const result = await getCreditPolicy(controller.signal);
            if (!controller.signal.aborted) setPolicy(result);
        } catch (error) {
            if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "积分计费状态加载失败");
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    };

    useEffect(() => {
        writing.current = false; setSaving(false); setPolicy(null);
        if (canRead) void refresh();
        else setLoading(false);
        return () => { request.current?.abort(); };
    }, [user?.id, user?.role, canRead]);

    const changePolicy = async (enabled: boolean) => {
        if (!canWrite || !policy || loading || writing.current || confirming.current) return;
        confirming.current = true;
        const confirmed = await modal.confirm({ title: `确认${enabled ? "开启" : "关闭"}积分计费？`, content: enabled ? "影响全部成员的新任务：将按已发布价格扣除积分，余额不足会阻止提交。现有余额与历史记录保留。" : "影响全部成员的新任务：将停止扣除站内积分，但模型服务仍可能产生人民币成本。现有余额与价格配置保留。", okText: `确认${enabled ? "开启" : "关闭"}`, cancelText: "保持不变", okButtonProps: { danger: true } });
        confirming.current = false;
        if (!confirmed) return;
        if (writing.current) return;
        writing.current = true; setSaving(true); setError(""); setNotice("");
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        try {
            const saved = await saveCreditPolicy(enabled, controller.signal);
            if (controller.signal.aborted) return;
            setPolicy(saved);
            const synchronized = await loadDeploymentFeatures();
            if (!controller.signal.aborted) setNotice(synchronized
                ? "计费设置已保存并同步；其他已打开页面请刷新以显示最新状态。"
                : "计费设置已保存，但当前页面同步失败；请刷新页面，避免显示旧状态。");
        } catch (error) {
            if (!controller.signal.aborted) {
                setPolicy(null);
                setError(`${error instanceof Error ? error.message : "计费设置保存失败"}。请重新读取状态，确认保存结果后再操作。`);
            }
        } finally {
            if (request.current === controller) { writing.current = false; setSaving(false); }
        }
    };

    if (!canRead) return null;
    return <section className="wb-surface space-y-3 p-5" aria-label="积分计费总开关" aria-busy={loading || saving}>
        <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold">积分计费总开关</h3>
            <Button size="small" loading={loading} disabled={saving} onClick={() => void refresh()}>刷新状态</Button>
        </div>
        {loading ? <Skeleton active title={false} paragraph={{ rows: 2 }} /> : null}
        {error ? <Alert type="error" showIcon title="当前计费状态未确认" description={error} /> : null}
        {policy && !loading ? <>
            <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{policy.creditsEnabled ? "已开启积分计费" : "已关闭积分计费"}</span>
                <Switch aria-label="启用积分计费" checked={policy.creditsEnabled} checkedChildren="开" unCheckedChildren="关" loading={saving} disabled={!canWrite || saving} onChange={(enabled) => void changePolicy(enabled)} />
            </div>
            <Alert type={policy.creditsEnabled ? "warning" : "info"} showIcon title={policy.creditsEnabled ? "新任务按板块配置扣除积分" : "新任务不扣积分"} description={policy.creditsEnabled
                ? "按已配置的板块价格与计费规则扣分，余额不足时不能提交需要积分的任务。"
                : "关闭不清空用户余额，也不清空板块价格；可先设置各人的积分和板块费用，再开启计费。"} />
            {!canWrite ? <p className="text-xs text-[var(--muted-foreground)]">仅超级管理员可修改此开关；部门管理员可查看当前状态。</p> : null}
        </> : null}
        {notice ? <Alert type="info" showIcon title={notice} /> : null}
    </section>;
}
