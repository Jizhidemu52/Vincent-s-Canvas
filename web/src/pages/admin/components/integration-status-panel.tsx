import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Table, Tag } from "antd";
import { RefreshCw } from "lucide-react";

import { getIntegrationStatus, type IntegrationStatus } from "@/services/api/integrations";

type StatusRow = { key: string; name: string; ready: boolean; detail: string };

export function IntegrationStatusPanel() {
    const { message } = App.useApp();
    const [status, setStatus] = useState<IntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const refresh = async () => {
        setLoading(true);
        try { setStatus(await getIntegrationStatus()); }
        catch (error) { message.error(error instanceof Error ? error.message : "系统集成状态加载失败"); }
        finally { setLoading(false); }
    };
    useEffect(() => { void refresh(); }, []);

    const rows = useMemo<StatusRow[]>(() => status ? [
        {
            key: "wecom",
            name: "企业微信 SSO",
            ready: status.wecom.configured && status.wecom.callbackUsesHttps,
            detail: status.wecom.configured
                ? `${status.wecom.callbackUrl}${status.wecom.callbackUsesHttps ? "" : "（回调必须使用 HTTPS）"}`
                : `缺少：${status.wecom.missing.join("、")}`,
        },
        { key: "storage", name: "公司对象存储", ready: status.objectStorage.configured, detail: status.objectStorage.configured ? `${status.objectStorage.endpoint} / ${status.objectStorage.bucket}` : "未配置" },
        { key: "provider", name: "Provider 密钥加密", ready: status.providerEncryption.configured, detail: status.providerEncryption.configured ? "已配置服务端加密密钥" : "未配置" },
        { key: "ldap", name: "LDAP", ready: false, detail: "接口已预留" },
        { key: "oidc", name: "OIDC", ready: false, detail: "接口已预留" },
    ] : [], [status]);

    return (
        <div className="space-y-4">
            {status?.taskRuntime.mockMode ? <Alert type="warning" showIcon message="当前仍在模拟任务模式，正式上线前必须关闭 TASK_MOCK_MODE" /> : null}
            <div className="flex items-center justify-between">
                <div className="text-sm text-stone-500">Worker 并发：{status?.taskRuntime.workerConcurrency ?? "-"}</div>
                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>刷新状态</Button>
            </div>
            <Table<StatusRow>
                rowKey="key"
                size="small"
                loading={loading}
                pagination={false}
                dataSource={rows}
                columns={[
                    { title: "集成", dataIndex: "name", width: 220 },
                    { title: "状态", width: 120, render: (_, row) => <Tag color={row.ready ? "green" : "orange"}>{row.ready ? "可用" : "待配置"}</Tag> },
                    { title: "诊断", dataIndex: "detail" },
                ]}
            />
        </div>
    );
}
