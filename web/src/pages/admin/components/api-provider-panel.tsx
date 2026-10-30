import { App, Button, Form, Input, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";

import { createServerProvider, listServerProviders, updateServerProvider, type ProviderProtocol, type ServerProvider } from "@/services/api/model-configuration";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";

type Values = { name: string; protocol: ProviderProtocol; baseUrl: string; enabled: boolean; apiKey?: string; walletApiKey?: string; accessKeyId?: string; secretAccessKey?: string };
const protocolOptions: Array<{ value: ProviderProtocol; label: string }> = [
    { value: "openai", label: "OpenAI（Responses / 图片）" },
    { value: "openai-chat", label: "OpenAI（Chat Completions）" },
    { value: "anthropic", label: "Anthropic（Messages）" },
    { value: "gemini", label: "gemini" },
    { value: "apimart", label: "APIMart 图片异步" },
    { value: "volcengine", label: "volcengine" },
    { value: "runninghub", label: "runninghub" },
    { value: "comfyui", label: "comfyui" },
    { value: "custom", label: "custom" },
];

export function ApiProviderPanel({ isAdmin }: { isAdmin: boolean }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<Values>();
    const [providers, setProviders] = useState<ServerProvider[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const { confirmDiscard } = useUnsavedGuard(dirty, "API 服务配置尚未保存，离开后将丢失修改；密钥不会自动保存。");
    const protocol = Form.useWatch("protocol", form);
    const selectProvider = async (id: string | null) => { if (id !== selectedId && await confirmDiscard()) { setDirty(false); setSelectedId(id); } };
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
        if (saving) return;
        setSaving(true);
        const credentials = Object.entries({ apiKey: values.apiKey, walletApiKey: values.walletApiKey, accessKeyId: values.accessKeyId, secretAccessKey: values.secretAccessKey }).reduce<Record<string, string>>((result, [key, value]) => {
            if (value) result[key] = value;
            return result;
        }, {});
        const input = { name: values.name, protocol: values.protocol, baseUrl: values.baseUrl, enabled: values.enabled, ...(Object.keys(credentials).length ? { credentials } : {}) };
        try {
            const result = selected ? await updateServerProvider(selected.id, input) : await createServerProvider(input);
            setDirty(false); setSelectedId(result.provider.id); message.success("API 服务已保存到服务端"); await refresh();
        } catch (error) { message.error(error instanceof Error ? error.message : "API 服务保存失败"); }
        finally { setSaving(false); }
    };

    return (
        <div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="grid min-w-0 gap-4">
                <Table className="min-w-0" scroll={{ x: 780 }} rowKey="id" size="small" loading={loading} dataSource={providers} columns={[
                    { title: "API 服务", render: (_, record: ServerProvider) => <Button type="link" className="!px-0" disabled={saving} onClick={() => void selectProvider(record.id)}>{record.name}</Button> },
                    { title: "协议", dataIndex: "protocol" }, { title: "Base URL", dataIndex: "baseUrl", ellipsis: true },
                    { title: "状态", render: (_, record: ServerProvider) => <Tag color={record.enabled ? "green" : "red"}>{record.enabled ? "启用" : "停用"}</Tag> },
                    { title: "服务端凭据", render: (_, record: ServerProvider) => <Tag color={record.hasCredentials ? "green" : "default"}>{record.hasCredentials ? "已加密配置" : "未配置"}</Tag> },
                ]} />
                <div className="wb-surface px-4 py-3 text-sm leading-6 text-[var(--muted-foreground)]">API Key 只会随本次请求发送到业务后端，使用 AES-256-GCM 加密后保存。此页面和普通模型列表都不会返回密钥、密钥片段或环境变量名。</div>
            </div>
            <section className="wb-surface p-5">
                <div className="mb-4 flex items-center justify-between"><Typography.Title level={3} className="!m-0 !text-base">{selected ? "编辑 API 服务" : "新增 API 服务"}</Typography.Title><Button size="small" disabled={saving} onClick={() => void selectProvider(null)}>新增</Button></div>
                <Form form={form} layout="vertical" disabled={!isAdmin || saving} onValuesChange={() => setDirty(true)} initialValues={{ protocol: "openai", enabled: true }} onFinish={submit}>
                    <Form.Item name="name" label="显示名称" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name="protocol" label="调用协议" rules={[{ required: true }]}><Select options={protocolOptions} /></Form.Item>
                    <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://api.example.com/v1" /></Form.Item>
                    <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                    <Form.Item name="apiKey" label="API Key"><Input.Password placeholder={selected?.hasCredentials ? "留空保持现有凭据" : "输入服务端密钥"} /></Form.Item>
                    {protocol === "runninghub" ? <Form.Item name="walletApiKey" label="Wallet API Key"><Input.Password /></Form.Item> : null}
                    {protocol === "volcengine" ? <Space className="w-full" orientation="vertical"><Form.Item name="accessKeyId" label="Access Key ID"><Input.Password /></Form.Item><Form.Item name="secretAccessKey" label="Secret Access Key"><Input.Password /></Form.Item></Space> : null}
                    <Button className="!h-10" type="primary" htmlType="submit" loading={saving} block>保存到服务端</Button>
                </Form>
            </section>
        </div>
    );
}
