import { App, Button, Form, Input, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";

import { createServerProvider, listServerProviders, updateServerProvider, type ProviderProtocol, type ServerProvider } from "@/services/api/model-configuration";

type Values = { name: string; protocol: ProviderProtocol; baseUrl: string; enabled: boolean; apiKey?: string; walletApiKey?: string; accessKeyId?: string; secretAccessKey?: string };
const protocolOptions = ["openai", "gemini", "volcengine", "runninghub", "comfyui", "custom"].map((value) => ({ label: value, value }));

export function ApiProviderPanel({ isAdmin }: { isAdmin: boolean }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<Values>();
    const [providers, setProviders] = useState<ServerProvider[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const selected = providers.find((provider) => provider.id === selectedId);

    const refresh = async () => {
        setLoading(true);
        try { const result = await listServerProviders(); setProviders(result.providers); if (!selectedId && result.providers[0]) setSelectedId(result.providers[0].id); }
        catch (error) { message.error(error instanceof Error ? error.message : "Provider 加载失败"); }
        finally { setLoading(false); }
    };
    useEffect(() => { void refresh(); }, []);
    useEffect(() => {
        if (selected) form.setFieldsValue({ name: selected.name, protocol: selected.protocol, baseUrl: selected.baseUrl, enabled: selected.enabled, apiKey: "", walletApiKey: "", accessKeyId: "", secretAccessKey: "" });
        else form.resetFields();
    }, [form, selected]);

    const submit = async (values: Values) => {
        const credentials = Object.entries({ apiKey: values.apiKey, walletApiKey: values.walletApiKey, accessKeyId: values.accessKeyId, secretAccessKey: values.secretAccessKey }).reduce<Record<string, string>>((result, [key, value]) => {
            if (value) result[key] = value;
            return result;
        }, {});
        const input = { name: values.name, protocol: values.protocol, baseUrl: values.baseUrl, enabled: values.enabled, ...(Object.keys(credentials).length ? { credentials } : {}) };
        try {
            const result = selected ? await updateServerProvider(selected.id, input) : await createServerProvider(input);
            setSelectedId(result.provider.id); message.success("Provider 已保存到服务端"); await refresh();
        } catch (error) { message.error(error instanceof Error ? error.message : "Provider 保存失败"); }
    };

    return (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="grid gap-4">
                <Table rowKey="id" size="small" loading={loading} dataSource={providers} columns={[
                    { title: "Provider", render: (_, record: ServerProvider) => <Button type="link" className="!px-0" onClick={() => setSelectedId(record.id)}>{record.name}</Button> },
                    { title: "协议", dataIndex: "protocol" }, { title: "Base URL", dataIndex: "baseUrl", ellipsis: true },
                    { title: "状态", render: (_, record: ServerProvider) => <Tag color={record.enabled ? "green" : "red"}>{record.enabled ? "启用" : "停用"}</Tag> },
                    { title: "服务端凭据", render: (_, record: ServerProvider) => <Tag color={record.hasCredentials ? "green" : "default"}>{record.hasCredentials ? "已加密配置" : "未配置"}</Tag> },
                ]} />
                <div className="rounded-md border border-orange-200 bg-orange-50 px-4 py-3 text-sm leading-6 text-orange-950">API Key 只会随本次请求发送到业务后端，使用 AES-256-GCM 加密后保存。此页面和普通模型列表都不会返回密钥、密钥片段或环境变量名。</div>
            </div>
            <section className="rounded-md border border-stone-200 bg-white p-4">
                <div className="mb-4 flex items-center justify-between"><Typography.Title level={3} className="!m-0 !text-base">{selected ? "编辑 Provider" : "新增 Provider"}</Typography.Title><Button size="small" onClick={() => setSelectedId(null)}>新增</Button></div>
                <Form form={form} layout="vertical" disabled={!isAdmin} initialValues={{ protocol: "openai", enabled: true }} onFinish={submit}>
                    <Form.Item name="name" label="显示名称" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name="protocol" label="调用协议" rules={[{ required: true }]}><Select options={protocolOptions} /></Form.Item>
                    <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://api.example.com/v1" /></Form.Item>
                    <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                    <Form.Item name="apiKey" label="API Key"><Input.Password placeholder={selected?.hasCredentials ? "留空保持现有凭据" : "输入服务端密钥"} /></Form.Item>
                    {form.getFieldValue("protocol") === "runninghub" ? <Form.Item name="walletApiKey" label="Wallet API Key"><Input.Password /></Form.Item> : null}
                    {form.getFieldValue("protocol") === "volcengine" ? <Space className="w-full" orientation="vertical"><Form.Item name="accessKeyId" label="Access Key ID"><Input.Password /></Form.Item><Form.Item name="secretAccessKey" label="Secret Access Key"><Input.Password /></Form.Item></Space> : null}
                    <Button type="primary" htmlType="submit" block>保存到服务端</Button>
                </Form>
            </section>
        </div>
    );
}
