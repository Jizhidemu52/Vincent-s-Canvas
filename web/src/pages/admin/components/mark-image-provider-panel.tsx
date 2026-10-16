import { Alert, App, Button, Form, Input, InputNumber, Space, Switch, Tag, Typography } from "antd";
import { KeyRound, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { MARK_IMAGE_BASE_URL, MARK_PLATFORM_MODELS } from "../../../../../shared/mark-image-models";
import { getMarkImageConfiguration, MarkImageConfigurationError, saveMarkImageConfiguration, type MarkImageConfiguration, type MarkImageConfigurationInput } from "@/services/api/mark-image-provider";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";

type Values = Omit<MarkImageConfigurationInput, "models"> & {
    models: Array<Omit<MarkImageConfigurationInput["models"][number], "modelId">>;
};

const imageModelIds = new Set<string>(MARK_PLATFORM_MODELS.filter(model => model.modelId !== "midjourney-blend" && model.capabilities.some(capability => capability === "generate")).map(model => model.modelId));
const textModelIds = new Set<string>(MARK_PLATFORM_MODELS.filter(model => model.capabilities.some(capability => capability === "chat")).map(model => model.modelId));
const modelGroups = [
    { key: "image", title: "图片模型", description: `${imageModelIds.size} 个出图模型，按各模型能力提供生成和参考图编辑。`, matches: (modelId: string) => imageModelIds.has(modelId) },
    { key: "text", title: "文字模型", description: "此处仅配置文字模型接入与开关；对话积分请在“板块 API 配置”中设置，并受积分总开关控制。文字并发限制尚未执行，供应商仍按实际请求计费。", matches: (modelId: string) => textModelIds.has(modelId) },
    { key: "video", title: "视频模型", description: "独立视频生成模型。", matches: (modelId: string) => modelId === "happyhorse-1.1" },
    { key: "blend", title: "多图融合", description: "Midjourney Blend：上传 2–4 张参考图进行融合，无需提示词。", matches: (modelId: string) => modelId === "midjourney-blend" },
];

function formValues(config: MarkImageConfiguration): Values {
    return {
        baseUrl: config.provider?.baseUrl || MARK_IMAGE_BASE_URL,
        apiKey: "",
        enabled: config.provider?.enabled ?? true,
        models: MARK_PLATFORM_MODELS.map(({ modelId, defaultEnabled }) => {
            const model = config.models.find((item) => item.modelId === modelId);
            return { enabled: model?.enabled ?? defaultEnabled, creditCost: model?.creditCost ?? 0, rmbCost: model?.rmbCost ?? 0, concurrencyLimit: model?.concurrencyLimit ?? 2 };
        }),
    };
}

export function MarkImageProviderPanel() {
    const { message } = App.useApp();
    const [form] = Form.useForm<Values>();
    const user = useUserStore((state) => state.user);
    const refreshBusinessConfig = useBusinessConfigStore((state) => state.refresh);
    const isAdmin = user?.role === "super_admin";
    const [config, setConfig] = useState<MarkImageConfiguration | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState("");
    const requestVersion = useRef(0);
    const savingRef = useRef(false);

    const load = useCallback(async () => {
        if (!isAdmin) return;
        const version = ++requestVersion.current;
        setLoading(true);
        setLoadError("");
        try {
            const result = await getMarkImageConfiguration();
            if (version !== requestVersion.current) return;
            setConfig(result);
            form.setFieldsValue(formValues(result));
        } catch (error) {
            if (version === requestVersion.current) setLoadError(error instanceof MarkImageConfigurationError ? error.message : "APIMart 平台配置加载失败，请重试。");
        } finally {
            if (version === requestVersion.current) setLoading(false);
        }
    }, [form, isAdmin]);

    useEffect(() => {
        setConfig(null);
        form.setFieldValue("apiKey", "");
        void load();
        return () => { requestVersion.current++; };
    }, [form, load, user?.id]);

    const submit = async (values: Values) => {
        if (!isAdmin || !config || loading || loadError || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        const version = requestVersion.current;
        try {
            const result = await saveMarkImageConfiguration({
                baseUrl: values.baseUrl.trim(),
                apiKey: values.apiKey?.trim() || undefined,
                enabled: values.enabled,
                models: MARK_PLATFORM_MODELS.map(({ modelId }, index) => ({ ...values.models[index], modelId })),
            });
            if (version !== requestVersion.current) return;
            setConfig(result);
            form.setFieldsValue(formValues(result));
            message.success("APIMart 平台配置已保存到服务端，未发起生成请求");
            try { await refreshBusinessConfig(); }
            catch { message.warning("配置已保存，但模型列表同步失败；请刷新页面后再选择模型。"); }
        } catch (error) {
            if (version === requestVersion.current) message.error(error instanceof MarkImageConfigurationError ? error.message : "APIMart 平台配置保存失败，请重试。");
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    };

    if (!isAdmin) return <Alert type="warning" showIcon title="仅超级管理员可配置 APIMart 平台" />;

    return (
        <section className="wb-surface p-4 sm:p-5" aria-label="APIMart 平台独立配置">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <Typography.Title level={3} className="!mb-2 !text-base">APIMart 平台 · 独立 API 配置</Typography.Title>
                    <Space wrap size={[6, 6]}>
                        <Tag>APIMart · 独立密钥</Tag>
                        <Tag>{imageModelIds.size} 图片 · {textModelIds.size} 文字 · 1 视频 · 1 多图融合</Tag>
                        <Tag color={config?.provider?.hasCredentials ? "green" : "default"} icon={<KeyRound className="size-3" />}>
                            {loading ? "正在读取凭据状态" : loadError ? "凭据状态未知" : config?.provider?.hasCredentials ? "服务端密钥已配置" : "服务端密钥未配置"}
                        </Tag>
                    </Space>
                </div>
            </div>
            <Alert className="mb-5" type="info" showIcon title="服务端独立保存，不改变现有板块绑定" description={`此入口用于正式业务服务，非演示模式配置。图片、文字、视频和多图融合共用此 APIMart 通道密钥，各模型独立启用；图片、视频与多图融合可设置积分、内部成本及并发。文字模型当前仅配置接入与开关。保存仅更新下方 ${MARK_PLATFORM_MODELS.length} 个模型，不切换其他模型，也不发起付费测试。`} />
            {loadError ? <Alert className="mb-5" type="error" showIcon title={loadError} action={<Button size="small" icon={<RefreshCw className="size-3" />} onClick={() => void load()} loading={loading}>重试读取</Button>} /> : null}
            <Form form={form} layout="vertical" autoComplete="off" disabled={loading || saving || !config || Boolean(loadError)} onFinish={submit} initialValues={formValues({ provider: null, models: [] })}>
                <div className="grid gap-x-5 lg:grid-cols-2">
                    <Form.Item name="baseUrl" label="APIMart API Base URL" rules={[{ required: true, whitespace: true, message: "请输入 API Base URL" }, { type: "url", message: "请输入有效的 HTTP 或 HTTPS 地址" }]}>
                        <Input placeholder={MARK_IMAGE_BASE_URL} />
                    </Form.Item>
                    <Form.Item name="apiKey" label="APIMart API Key" extra={config?.provider?.hasCredentials ? "留空保留现有密钥；填写新密钥会替换现有密钥。" : "首次保存必须填写密钥，密钥不会回显。"} rules={[{ validator: async (_, value: string | undefined) => { if (!config?.provider?.hasCredentials && !value?.trim()) throw new Error("首次保存请填写 APIMart API Key"); } }]}>
                        <Input.Password autoComplete="new-password" placeholder={config?.provider?.hasCredentials ? "留空保留现有密钥" : "输入 APIMart API Key"} />
                    </Form.Item>
                </div>
                <Form.Item name="enabled" label="启用 APIMart 平台通道" valuePropName="checked">
                    <Switch checkedChildren="启用" unCheckedChildren="停用" />
                </Form.Item>
                <div className="mb-4">
                    <Typography.Title level={4} className="!mb-1 !text-sm">独立模型设置</Typography.Title>
                    <Typography.Text type="secondary" className="text-xs leading-5">积分是站内额度，成本仅用于内部记录；初始值 0 不代表上游 API 免费。并发范围为 1–100。模型需同时满足通道与自身启用才可用。</Typography.Text>
                </div>
                <div className="grid gap-4">
                    {modelGroups.map(group => (
                        <section key={group.key} aria-labelledby={`mark-model-group-${group.key}`} className="space-y-4 border-t border-[var(--border)] pt-4">
                            <div>
                                <Typography.Title id={`mark-model-group-${group.key}`} level={4} className="!mb-1 !text-sm">{group.title}</Typography.Title>
                                <Typography.Text type="secondary" className="text-xs">{group.description}</Typography.Text>
                            </div>
                            {MARK_PLATFORM_MODELS.map((model, index) => group.matches(model.modelId) ? (
                                <div key={model.modelId} className="rounded-lg border border-[var(--border)] p-3 sm:p-4">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <Typography.Text strong className="break-all">{model.name}</Typography.Text>
                                            <Typography.Text type="secondary" className="mt-1 block text-xs" aria-label={`${model.name} 用途`}>用途：{model.description}</Typography.Text>
                                        </div>
                                        <Form.Item className="!mb-0" name={["models", index, "enabled"]} valuePropName="checked">
                                            <Switch aria-label={`启用 ${model.name}`} checkedChildren="启用" unCheckedChildren="停用" />
                                        </Form.Item>
                                    </div>
                                    <div className="grid gap-x-4 sm:grid-cols-3">
                                        <Form.Item name={["models", index, "creditCost"]} label="站内积分 / 次" rules={[{ required: true, type: "integer", min: 0, message: "请输入不小于 0 的整数" }]}>
                                            <InputNumber className="!w-full" min={0} precision={0} disabled={group.key === "text" ? true : undefined} aria-label={`${model.name} 站内积分`} />
                                        </Form.Item>
                                        <Form.Item name={["models", index, "rmbCost"]} label="内部成本记录 / 元" rules={[{ required: true, type: "number", min: 0, message: "请输入不小于 0 的成本" }]}>
                                            <InputNumber className="!w-full" min={0} precision={4} disabled={group.key === "text" ? true : undefined} aria-label={`${model.name} 内部成本`} />
                                        </Form.Item>
                                        <Form.Item name={["models", index, "concurrencyLimit"]} label="并发上限" rules={[{ required: true, type: "integer", min: 1, max: 100, message: "请输入 1–100 的整数" }]}>
                                            <InputNumber className="!w-full" min={1} max={100} precision={0} disabled={group.key === "text" ? true : undefined} aria-label={`${model.name} 并发上限`} />
                                        </Form.Item>
                                    </div>
                                </div>
                            ) : null)}
                        </section>
                    ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                    <Typography.Text type="secondary" className="text-xs">密钥仅随保存请求发送至业务后端，不在浏览器持久化；保存成功后输入框会清空。</Typography.Text>
                    <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={saving}>保存 APIMart 平台配置</Button>
                </div>
            </Form>
        </section>
    );
}
