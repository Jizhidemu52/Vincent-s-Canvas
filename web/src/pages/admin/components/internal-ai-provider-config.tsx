import { KeyRound, PlugZap, Save, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, Space, Tag, Typography } from "antd";

import { getInternalAiConfig, saveInternalAiConfig, testInternalAiConfig, type InternalAiConfigStatus } from "@/services/api/internal-ai-config";

type InternalAiFormValues = {
    seamlessUrl: string;
    appKey?: string;
};

const DEFAULT_SEAMLESS_URL = "http://122.247.78.91:8101/std/comfy_generate";

export function InternalAiProviderConfig({ isAdmin }: { isAdmin: boolean }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<InternalAiFormValues>();
    const [status, setStatus] = useState<InternalAiConfigStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

    useEffect(() => {
        let active = true;
        getInternalAiConfig()
            .then((value) => {
                if (!active) return;
                setStatus(value);
                form.setFieldsValue({ seamlessUrl: value.seamlessUrl || DEFAULT_SEAMLESS_URL, appKey: "" });
            })
            .catch((error) => {
                if (active) message.error(error instanceof Error ? error.message : "内部 AI 配置读取失败");
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [form, message]);

    const submit = async (values: InternalAiFormValues) => {
        setSaving(true);
        try {
            const nextStatus = await saveInternalAiConfig({
                seamlessUrl: values.seamlessUrl,
                appKey: values.appKey?.trim() || undefined,
            });
            setStatus(nextStatus);
            form.setFieldValue("appKey", "");
            setTestResult(null);
            message.success("内部 AI 配置已保存到服务端");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "内部 AI 配置保存失败");
        } finally {
            setSaving(false);
        }
    };

    const testConnection = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await testInternalAiConfig();
            setTestResult({ type: "success", message: result.message });
            message.success(result.message);
        } catch (error) {
            const reason = error instanceof Error ? error.message : "内部 AI 连接测试失败";
            setTestResult({ type: "error", message: reason });
            message.error(reason);
        } finally {
            setTesting(false);
        }
    };

    const clearAppKey = async () => {
        const seamlessUrl = form.getFieldValue("seamlessUrl") || status?.seamlessUrl || DEFAULT_SEAMLESS_URL;
        setSaving(true);
        try {
            const nextStatus = await saveInternalAiConfig({ seamlessUrl, clearAppKey: true });
            setStatus(nextStatus);
            form.setFieldValue("appKey", "");
            message.success("内部 AI App Key 已从服务端清除");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "App Key 清除失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="rounded-md border border-orange-200 bg-white p-4 dark:border-orange-900 dark:bg-stone-900">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <Typography.Title level={3} className="!mb-1 !text-base">
                        内部 AI · 四方连续进阶
                    </Typography.Title>
                    <Space wrap size={[6, 6]}>
                        <Tag icon={<Server className="size-3" />} color="orange">
                            无缝拼接 · sflxjj
                        </Tag>
                        <Tag>POST JSON</Tag>
                        <Tag>真实工作流出图</Tag>
                    </Space>
                </div>
                <Space wrap>
                    <Tag color={status?.seamlessUrl ? "green" : "default"}>{status?.seamlessUrl ? "接口地址已配置" : "接口地址未配置"}</Tag>
                    <Tag icon={<KeyRound className="size-3" />} color={status?.hasAppKey ? "green" : "default"}>
                        {status?.hasAppKey ? status.appKeyPreview : "App Key 未填写"}
                    </Tag>
                </Space>
            </div>

            <Form form={form} layout="vertical" disabled={!isAdmin || loading} onFinish={submit} initialValues={{ seamlessUrl: DEFAULT_SEAMLESS_URL }}>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
                    <Form.Item
                        name="seamlessUrl"
                        label="无缝拼接接口地址"
                        rules={[
                            { required: true, message: "请输入接口地址" },
                            { type: "url", message: "请输入有效的 HTTP 或 HTTPS 地址" },
                        ]}
                    >
                        <Input prefix={<Server className="size-4 text-stone-400" />} placeholder={DEFAULT_SEAMLESS_URL} />
                    </Form.Item>
                    <Form.Item name="appKey" label="App Key">
                        <Input.Password prefix={<KeyRound className="size-4 text-stone-400" />} placeholder={status?.hasAppKey ? "留空则保留当前密钥" : "粘贴内部 AI App Key"} autoComplete="new-password" />
                    </Form.Item>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <Typography.Text type="secondary" className="text-xs">
                        密钥原文只写入服务端，页面仅显示脱敏状态。
                    </Typography.Text>
                    <Space wrap>
                        {status?.hasAppKey ? (
                            <Button danger onClick={clearAppKey} disabled={!isAdmin} loading={saving}>
                                清除 App Key
                            </Button>
                        ) : null}
                        <Button icon={<PlugZap className="size-4" />} onClick={testConnection} disabled={!isAdmin || loading} loading={testing}>
                            真实测试出图
                        </Button>
                        <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={saving}>
                            保存到服务端
                        </Button>
                    </Space>
                </div>
            </Form>
            <Typography.Text type="secondary" className="mt-3 block text-xs leading-5">
                测试会提交一张服务端测试图并检查是否返回图片结果，通常需要几十秒。App Key 不会返回浏览器，也不会写入日志或 Git。
            </Typography.Text>
            {testResult ? <Alert className="mt-3" type={testResult.type} showIcon message={testResult.message} /> : null}
        </section>
    );
}
