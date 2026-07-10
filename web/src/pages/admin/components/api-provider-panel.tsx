import { useEffect, useMemo, useState } from "react";
import { App, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tag, Typography } from "antd";

import { getPublicProviderModels, type AdminApiProvider, type AdminApiProviderModel, type AdminProviderModelType, type AdminProviderProtocol } from "@/lib/admin-domain";
import { InternalAiProviderConfig } from "@/pages/admin/components/internal-ai-provider-config";
import { CompanyAssetDatabaseConfig } from "@/pages/admin/components/company-asset-database-config";
import { useAdminStore } from "@/stores/use-admin-store";

type ProviderFormValues = {
    id: string;
    name: string;
    baseUrl: string;
    protocol: AdminProviderProtocol;
    imageRequestMode: AdminApiProvider["imageRequestMode"];
    imageGenerationEndpoint: string;
    imageEditEndpoint: string;
    enabled: boolean;
    primary: boolean;
    imageModels: string[];
    chatModels: string[];
    videoModels: string[];
    defaultCreditCost: number;
    defaultRmbCost: number;
};

type SecretFormValues = {
    providerId: string;
    secretName: "api_key" | "wallet_api_key" | "volcengine_access_key_id" | "volcengine_secret_access_key";
    value: string;
};

const protocolOptions: Array<{ label: string; value: AdminProviderProtocol }> = [
    { label: "OpenAI 兼容", value: "openai" },
    { label: "Gemini", value: "gemini" },
    { label: "火山引擎", value: "volcengine" },
    { label: "RunningHub", value: "runninghub" },
    { label: "Codex", value: "codex" },
    { label: "自定义", value: "custom" },
];

const imageModeOptions: Array<{ label: string; value: AdminApiProvider["imageRequestMode"] }> = [
    { label: "openai", value: "openai" },
    { label: "openai-json", value: "openai-json" },
    { label: "openai-video-proxy", value: "openai-video-proxy" },
    { label: "openai-responses", value: "openai-responses" },
];

const secretOptions: Array<{ label: string; value: SecretFormValues["secretName"] }> = [
    { label: "API Key", value: "api_key" },
    { label: "RunningHub 钱包 Key", value: "wallet_api_key" },
    { label: "火山 Access Key ID", value: "volcengine_access_key_id" },
    { label: "火山 Secret Access Key", value: "volcengine_secret_access_key" },
];

export function ApiProviderPanel({ isAdmin }: { isAdmin: boolean }) {
    const { message } = App.useApp();
    const state = useAdminStore();
    const [providerForm] = Form.useForm<ProviderFormValues>();
    const [secretForm] = Form.useForm<SecretFormValues>();
    const [selectedProviderId, setSelectedProviderId] = useState(state.apiProviders[0]?.id || "");
    const selectedProvider = state.apiProviders.find((provider) => provider.id === selectedProviderId) || state.apiProviders[0];
    const providerOptions = state.apiProviders.map((provider) => ({ label: provider.name, value: provider.id }));
    const publicPreview = useMemo(() => JSON.stringify(getPublicProviderModels(state), null, 2), [state.apiProviders]);

    useEffect(() => {
        if (!selectedProvider) return;
        providerForm.setFieldsValue(providerToForm(selectedProvider));
        secretForm.setFieldsValue({ providerId: selectedProvider.id, secretName: "api_key", value: "" });
    }, [providerForm, secretForm, selectedProvider]);

    const submitProvider = (values: ProviderFormValues) => {
        const existing = state.apiProviders.find((provider) => provider.id === selectedProvider?.id);
        const provider = formToProvider(values, existing);
        const result = state.saveApiProvider(provider);
        if (result.ok) {
            setSelectedProviderId(provider.id);
            message.success("Provider 配置已保存");
        } else {
            message.error(result.reason || "Provider 保存失败");
        }
    };

    const submitSecret = (values: SecretFormValues) => {
        const result = state.saveApiProviderSecret(values.providerId, values.secretName, values.value);
        if (result.ok) {
            secretForm.setFieldValue("value", "");
            message.success("密钥已保存为脱敏状态");
        } else {
            message.error(result.reason || "密钥保存失败");
        }
    };

    const clearSecret = () => {
        const values = secretForm.getFieldsValue();
        const result = state.clearApiProviderSecret(values.providerId, values.secretName);
        if (result.ok) message.success("密钥状态已清除");
        else message.error(result.reason || "密钥清除失败");
    };

    return (
        <div className="grid gap-4">
            <CompanyAssetDatabaseConfig isAdmin={isAdmin} />
            <InternalAiProviderConfig isAdmin={isAdmin} />
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
                <div className="grid gap-4">
                    <Table
                        rowKey="id"
                        size="small"
                        pagination={false}
                        dataSource={state.apiProviders}
                        columns={[
                            {
                                title: "Provider",
                                render: (_, record: AdminApiProvider) => (
                                    <Button type="link" className="!px-0" onClick={() => setSelectedProviderId(record.id)}>
                                        {record.name}
                                    </Button>
                                ),
                            },
                            { title: "协议", dataIndex: "protocol" },
                            {
                                title: "状态",
                                render: (_, record: AdminApiProvider) => (
                                    <Space>
                                        <Tag color={record.enabled ? "green" : "red"}>{record.enabled ? "启用" : "停用"}</Tag>
                                        {record.primary ? <Tag color="orange">主 Provider</Tag> : null}
                                    </Space>
                                ),
                            },
                            { title: "密钥", render: (_, record: AdminApiProvider) => <SecretStatus provider={record} /> },
                            {
                                title: "模型",
                                render: (_, record: AdminApiProvider) => (
                                    <Space wrap>
                                        {(["image", "chat", "video"] as const).map((type) => (
                                            <Tag key={type}>
                                                {type}: {record.models.filter((model) => model.modelType === type).length}
                                            </Tag>
                                        ))}
                                    </Space>
                                ),
                            },
                        ]}
                    />

                    <section className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                        <Typography.Title level={3} className="!mb-3 !text-base">
                            普通前端可见模型预览
                        </Typography.Title>
                        <pre className="max-h-72 overflow-auto rounded-md bg-stone-950 p-3 text-xs leading-5 text-orange-100">{publicPreview}</pre>
                        <div className="mt-3 text-xs leading-5 text-stone-500 dark:text-stone-400">这个结构只包含 provider 名称、模型能力、积分和成本，不包含 API Key、key preview、env 名或 base_url。</div>
                    </section>
                </div>

                <div className="grid gap-4">
                    <section className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                        <Typography.Title level={3} className="!mb-4 !text-base">
                            Provider 配置
                        </Typography.Title>
                        <Select className="mb-3 w-full" value={selectedProvider?.id} options={providerOptions} onChange={setSelectedProviderId} />
                        <Form form={providerForm} layout="vertical" disabled={!isAdmin} onFinish={submitProvider}>
                            <div className="grid grid-cols-2 gap-3">
                                <Form.Item name="id" label="Provider ID" rules={[{ required: true }]}>
                                    <Input placeholder="custom-api" />
                                </Form.Item>
                                <Form.Item name="name" label="显示名称" rules={[{ required: true }]}>
                                    <Input placeholder="自定义 API" />
                                </Form.Item>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
                                    <Select options={protocolOptions} />
                                </Form.Item>
                                <Form.Item name="imageRequestMode" label="图片请求模式" rules={[{ required: true }]}>
                                    <Select options={imageModeOptions} />
                                </Form.Item>
                            </div>
                            <Form.Item name="baseUrl" label="Base URL">
                                <Input placeholder="https://example.com/v1" />
                            </Form.Item>
                            <div className="grid grid-cols-2 gap-3">
                                <Form.Item name="imageGenerationEndpoint" label="文生图 Endpoint">
                                    <Input placeholder="可选覆盖" />
                                </Form.Item>
                                <Form.Item name="imageEditEndpoint" label="图片编辑 Endpoint">
                                    <Input placeholder="可选覆盖" />
                                </Form.Item>
                            </div>
                            <Form.Item name="imageModels" label="图片模型">
                                <Select mode="tags" open={false} placeholder="输入模型 ID 后回车" />
                            </Form.Item>
                            <Form.Item name="chatModels" label="聊天模型">
                                <Select mode="tags" open={false} placeholder="输入模型 ID 后回车" />
                            </Form.Item>
                            <Form.Item name="videoModels" label="视频模型">
                                <Select mode="tags" open={false} placeholder="输入模型 ID 后回车" />
                            </Form.Item>
                            <div className="grid grid-cols-2 gap-3">
                                <Form.Item name="defaultCreditCost" label="默认积分">
                                    <InputNumber className="w-full" min={0} max={100000} />
                                </Form.Item>
                                <Form.Item name="defaultRmbCost" label="默认成本">
                                    <InputNumber className="w-full" min={0} max={100000} precision={2} />
                                </Form.Item>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <Form.Item name="enabled" label="启用" valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                                <Form.Item name="primary" label="主 Provider" valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </div>
                            <Button type="primary" htmlType="submit" block>
                                保存 Provider
                            </Button>
                        </Form>
                    </section>

                    <section className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                        <Typography.Title level={3} className="!mb-4 !text-base">
                            密钥状态
                        </Typography.Title>
                        <Form form={secretForm} layout="vertical" disabled={!isAdmin} onFinish={submitSecret}>
                            <Form.Item name="providerId" label="Provider" rules={[{ required: true }]}>
                                <Select options={providerOptions} />
                            </Form.Item>
                            <Form.Item name="secretName" label="密钥类型" rules={[{ required: true }]}>
                                <Select options={secretOptions} />
                            </Form.Item>
                            <Form.Item name="value" label="新密钥" rules={[{ required: true }]}>
                                <Input.Password placeholder="只用于本次保存，保存后不留明文" />
                            </Form.Item>
                            <Space className="w-full" orientation="vertical">
                                <Button type="primary" htmlType="submit" block>
                                    保存密钥状态
                                </Button>
                                <Button danger block onClick={clearSecret}>
                                    清除当前密钥状态
                                </Button>
                            </Space>
                        </Form>
                    </section>
                </div>
            </div>
        </div>
    );
}

function SecretStatus({ provider }: { provider: AdminApiProvider }) {
    if (provider.id === "internal-ai") return <Tag color="orange">服务端专属配置</Tag>;
    const secret = provider.secretStatus;
    return (
        <Space wrap>
            <Tag color={secret.hasKey ? "green" : "default"}>
                {secret.keyEnv}: {secret.hasKey ? secret.keyPreview : "未配置"}
            </Tag>
            {provider.id === "runninghub" ? (
                <Tag color={secret.hasWalletKey ? "green" : "default"}>
                    {secret.walletKeyEnv}: {secret.hasWalletKey ? secret.walletKeyPreview : "未配置"}
                </Tag>
            ) : null}
            {provider.id === "volcengine" ? (
                <>
                    <Tag color={secret.hasVolcengineAccessKey ? "green" : "default"}>
                        {secret.volcengineAccessKeyEnv}: {secret.hasVolcengineAccessKey ? secret.volcengineAccessKeyPreview : "未配置"}
                    </Tag>
                    <Tag color={secret.hasVolcengineSecretKey ? "green" : "default"}>
                        {secret.volcengineSecretKeyEnv}: {secret.hasVolcengineSecretKey ? secret.volcengineSecretKeyPreview : "未配置"}
                    </Tag>
                </>
            ) : null}
        </Space>
    );
}

function providerToForm(provider: AdminApiProvider): ProviderFormValues {
    return {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        imageRequestMode: provider.imageRequestMode,
        imageGenerationEndpoint: provider.imageGenerationEndpoint,
        imageEditEndpoint: provider.imageEditEndpoint,
        enabled: provider.enabled,
        primary: provider.primary,
        imageModels: modelsByType(provider.models, "image"),
        chatModels: modelsByType(provider.models, "chat"),
        videoModels: modelsByType(provider.models, "video"),
        defaultCreditCost: provider.models[0]?.creditCost || 0,
        defaultRmbCost: provider.models[0]?.rmbCost || 0,
    };
}

function formToProvider(values: ProviderFormValues, existing?: AdminApiProvider): AdminApiProvider {
    const now = new Date().toISOString();
    const creditCost = Math.max(0, Math.floor(values.defaultCreditCost || 0));
    const rmbCost = Math.max(0, Number(values.defaultRmbCost || 0));
    const modelGroups: Array<{ type: AdminProviderModelType; items: string[]; offset: number }> = [
        { type: "image", items: values.imageModels || [], offset: 0 },
        { type: "chat", items: values.chatModels || [], offset: 100 },
        { type: "video", items: values.videoModels || [], offset: 200 },
    ];
    const models = modelGroups.flatMap((group) =>
        Array.from(new Set(group.items.map((item) => item.trim()).filter(Boolean))).map((modelId, index) => {
            const previous = existing?.models.find((model) => model.modelId === modelId && model.modelType === group.type);
            return {
                id: previous?.id || `${values.id}-${group.type}-${modelId}`,
                modelId,
                displayName: previous?.displayName || modelId,
                modelType: group.type,
                capabilities: previous?.capabilities || (group.type === "image" ? ["generate"] : ["generate"]),
                protocolOverride: previous?.protocolOverride,
                enabled: previous?.enabled ?? true,
                sortOrder: previous?.sortOrder ?? group.offset + index + 1,
                creditCost: previous?.creditCost ?? creditCost,
                rmbCost: previous?.rmbCost ?? rmbCost,
                priceRuleId: previous?.priceRuleId,
            } satisfies AdminApiProviderModel;
        }),
    );

    return {
        id: values.id,
        name: values.name,
        baseUrl: values.baseUrl || "",
        protocol: values.protocol,
        imageRequestMode: values.imageRequestMode,
        imageGenerationEndpoint: values.imageGenerationEndpoint || "",
        imageEditEndpoint: values.imageEditEndpoint || "",
        enabled: Boolean(values.enabled),
        primary: Boolean(values.primary),
        volcengineProjectName: existing?.volcengineProjectName || "",
        volcengineRegion: existing?.volcengineRegion || "",
        models,
        loras: existing?.loras || [],
        runningHubEntries: existing?.runningHubEntries || [],
        secretStatus: existing?.secretStatus || { hasKey: false, keyPreview: "", keyEnv: "" },
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    };
}

function modelsByType(models: AdminApiProviderModel[], type: AdminProviderModelType) {
    return models.filter((model) => model.modelType === type).map((model) => model.modelId);
}
