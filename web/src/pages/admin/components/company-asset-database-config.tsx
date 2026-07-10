import { Database, KeyRound, PlugZap, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, Space, Switch, Tag, Typography } from "antd";

import { getCompanyAssetDatabaseConfig, saveCompanyAssetDatabaseConfig, testCompanyAssetDatabaseConfig, type CompanyAssetDatabaseInput, type CompanyAssetDatabaseStatus } from "@/services/api/company-assets";

const defaults: CompanyAssetDatabaseInput = {
    baseUrl: "",
    uploadPath: "/api/assets",
    queryPath: "/api/assets",
    healthPath: "/health",
    enabled: false,
};

export function CompanyAssetDatabaseConfig({ isAdmin }: { isAdmin: boolean }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<CompanyAssetDatabaseInput>();
    const [status, setStatus] = useState<CompanyAssetDatabaseStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

    useEffect(() => {
        let active = true;
        getCompanyAssetDatabaseConfig()
            .then((value) => {
                if (!active) return;
                setStatus(value);
                form.setFieldsValue({ ...value, apiToken: "" });
            })
            .catch((error) => active && message.error(error instanceof Error ? error.message : "公司素材数据库配置读取失败"))
            .finally(() => active && setLoading(false));
        return () => {
            active = false;
        };
    }, [form, message]);

    const submit = async (values: CompanyAssetDatabaseInput) => {
        setSaving(true);
        try {
            const next = await saveCompanyAssetDatabaseConfig({ ...values, apiToken: values.apiToken?.trim() || undefined });
            setStatus(next);
            form.setFieldValue("apiToken", "");
            setTestResult(null);
            message.success("公司素材数据库配置已保存到服务端");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "配置保存失败");
        } finally {
            setSaving(false);
        }
    };

    const testConnection = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await testCompanyAssetDatabaseConfig();
            setTestResult({ type: "success", message: result.message });
        } catch (error) {
            setTestResult({ type: "error", message: error instanceof Error ? error.message : "连接测试失败" });
        } finally {
            setTesting(false);
        }
    };

    return (
        <section className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <Typography.Title level={3} className="!mb-1 !text-base">
                        公司素材数据库
                    </Typography.Title>
                    <Typography.Text type="secondary" className="text-xs">
                        所有生成和上传素材按 ownerId 写入公司服务；设计师只查自己的素材，管理员可跨设计师查询。
                    </Typography.Text>
                </div>
                <Space wrap>
                    <Tag icon={<Database className="size-3" />} color={status?.enabled ? "green" : "default"}>
                        {status?.enabled ? "自动同步已启用" : "自动同步未启用"}
                    </Tag>
                    <Tag icon={<KeyRound className="size-3" />} color={status?.hasApiToken ? "green" : "default"}>
                        {status?.hasApiToken ? status.apiTokenPreview : "服务令牌未填写"}
                    </Tag>
                </Space>
            </div>

            <Form form={form} layout="vertical" disabled={!isAdmin || loading} initialValues={defaults} onFinish={submit}>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)_auto] lg:items-end">
                    <Form.Item name="baseUrl" label="数据库服务地址" rules={[{ type: "url", message: "请输入有效的 HTTP 或 HTTPS 地址" }]}>
                        <Input prefix={<Database className="size-4 text-stone-400" />} placeholder="https://assets.company.internal" />
                    </Form.Item>
                    <Form.Item name="apiToken" label="服务端 API Token">
                        <Input.Password prefix={<KeyRound className="size-4 text-stone-400" />} placeholder={status?.hasApiToken ? "留空则保留当前令牌" : "可选：Bearer Token"} autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item name="enabled" label="自动同步" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                    <Form.Item name="uploadPath" label="上传路径">
                        <Input placeholder="/api/assets" />
                    </Form.Item>
                    <Form.Item name="queryPath" label="查询路径">
                        <Input placeholder="/api/assets" />
                    </Form.Item>
                    <Form.Item name="healthPath" label="健康检查路径">
                        <Input placeholder="/health" />
                    </Form.Item>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <Typography.Text type="secondary" className="text-xs">
                        Token 原文只保存在服务端。未启用时素材继续保存在本机，不会阻塞创作。
                    </Typography.Text>
                    <Space wrap>
                        <Button icon={<PlugZap className="size-4" />} onClick={testConnection} disabled={!isAdmin || loading} loading={testing}>
                            测试连接
                        </Button>
                        <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={saving}>
                            保存数据库配置
                        </Button>
                    </Space>
                </div>
            </Form>
            {testResult ? <Alert className="mt-3" type={testResult.type} showIcon message={testResult.message} /> : null}
        </section>
    );
}
