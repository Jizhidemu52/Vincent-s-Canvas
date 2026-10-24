import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Form, Input, Select, Switch, Tag } from "antd";
import { activateAdminPromptVersion, createAdminPromptVersion, requirePromptAdmin, updateAdminPromptRecipe, type PromptAdminModel, type PromptRecipeDetail } from "@/services/api/admin-prompt-recipes";
import type { PromptRecipeSettings } from "../../../../../../shared/prompt-contracts";
import { assertFallback, editVersion, messageOf, parseVersion, type VersionEditorValue } from "../model";

const fields: Array<{ key: keyof VersionEditorValue; label: string; rows?: number }> = [
    { key: "systemPrompt", label: "系统提示词", rows: 14 },
    { key: "fieldTemplate", label: "场景字段模板", rows: 7 },
    { key: "overridesJson", label: "模型覆盖规则（JSON 对象，值为文本）", rows: 7 },
    { key: "fallbackPrompt", label: "回退提示词", rows: 6 },
    { key: "changeNote", label: "版本说明", rows: 2 },
];
export function RecipeEditor({ detail, models, refresh, onDirty }: { detail: PromptRecipeDetail; models: PromptAdminModel[]; refresh: () => Promise<PromptRecipeDetail>; onDirty: (dirty: boolean) => void }) {
    const { message, modal } = App.useApp();
    const owner = useRef(requirePromptAdmin()).current;
    const lifetime = useRef(new AbortController());
    useEffect(() => {
        lifetime.current = new AbortController();
        return () => lifetime.current.abort();
    }, []);
    const [settings, setSettings] = useState<PromptRecipeSettings>(detail.recipe);
    const [selectedId, setSelectedId] = useState(detail.recipe.currentVersionId || detail.versions[0]?.id || "");
    const selected = detail.versions.find((version) => version.id === selectedId);
    const [editor, setEditor] = useState<VersionEditorValue | null>(selected ? editVersion(selected) : null);
    const [compareId, setCompareId] = useState("");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    useEffect(() => {
        setSettings(detail.recipe);
    }, [detail.recipe.updatedAt]);
    useEffect(() => {
        if (selected) setEditor(editVersion(selected));
    }, [selected?.id]);
    const settingsDirty = ["name", "enabled", "modelConfigId", "failurePolicy"].some((key) => settings[key as keyof PromptRecipeSettings] !== detail.recipe[key as keyof PromptRecipeSettings]);
    const versionDirty = Boolean(editor && selected && JSON.stringify(editor) !== JSON.stringify(editVersion(selected)));
    useEffect(() => {
        onDirty(settingsDirty || versionDirty);
    }, [settingsDirty, versionDirty, onDirty]);
    const options = () => ({ expectedOwnerId: owner, signal: lifetime.current.signal });
    const run = async (name: string, action: () => Promise<void>) => {
        if (busy) return;
        setBusy(name);
        setError("");
        try {
            await action();
        } catch (reason) {
            if (!lifetime.current.signal.aborted) setError(messageOf(reason));
        } finally {
            if (!lifetime.current.signal.aborted) setBusy("");
        }
    };
    const changeVersion = (id: string) => {
        if (versionDirty) modal.confirm({ title: "放弃当前未保存的版本修改？", okText: "放弃并切换", cancelText: "继续编辑", onOk: () => setSelectedId(id) });
        else setSelectedId(id);
    };
    const compare = detail.versions.find((version) => version.id === compareId);
    const base = compare ? editVersion(compare) : null;
    return (
        <div className="flex min-w-0 flex-col gap-5">
            {error && <Alert type="error" title={error} showIcon />}
            <section className="wb-surface p-4 sm:p-5">
                <h3 className="mb-4 font-semibold">运行设置</h3>
                <Form layout="vertical" disabled={Boolean(busy)}>
                    <div className="grid gap-x-4 sm:grid-cols-2">
                        <Form.Item label="配方名称">
                            <Input aria-label="配方名称" value={settings.name} maxLength={120} onChange={(event) => setSettings({ ...settings, name: event.target.value })} />
                        </Form.Item>
                        <Form.Item label="独立优化模型" extra="仅使用此配方的绑定，不借用聊天模块的全局模型。">
                            <Select
                                aria-label="独立优化模型"
                                allowClear
                                placeholder="尚未绑定"
                                value={settings.modelConfigId ?? undefined}
                                onChange={(value) => setSettings({ ...settings, modelConfigId: value ?? null })}
                                options={models.filter((model) => model.capabilities.includes("chat")).map((model) => ({ value: model.id, label: `${model.name} · ${model.modelId}` }))}
                            />
                        </Form.Item>
                        <Form.Item label="失败策略">
                            <Select
                                aria-label="失败策略"
                                value={settings.failurePolicy}
                                onChange={(failurePolicy) => setSettings({ ...settings, failurePolicy })}
                                options={[
                                    { value: "stop", label: "停止并提示错误（默认）" },
                                    { value: "fallback", label: "使用该版本的回退提示词" },
                                ]}
                            />
                        </Form.Item>
                        <Form.Item label="是否启用">
                            <Switch aria-label="启用配方" checked={settings.enabled} onChange={(enabled) => setSettings({ ...settings, enabled })} />
                        </Form.Item>
                    </div>
                    <Button
                        type="primary"
                        disabled={!settingsDirty || Boolean(busy)}
                        loading={busy === "settings"}
                        onClick={() =>
                            void run("settings", async () => {
                                assertFallback(
                                    settings.failurePolicy,
                                    detail.versions.find((version) => version.id === detail.recipe.currentVersionId),
                                );
                                await updateAdminPromptRecipe(detail.recipe.key, settings, options());
                                await refresh();
                                message.success("运行设置已保存");
                            })
                        }
                    >
                        保存运行设置
                    </Button>
                </Form>
            </section>
            <section className="wb-surface min-w-0 p-4 sm:p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-semibold">版本内容</h3>
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            aria-label="编辑版本"
                            className="min-w-48"
                            value={selectedId || undefined}
                            disabled={Boolean(busy)}
                            onChange={changeVersion}
                            options={detail.versions.map((version) => ({ value: version.id, label: `v${version.version}${version.id === detail.recipe.currentVersionId ? " · 线上" : " · 未激活"}` }))}
                        />
                        <Select
                            aria-label="对比版本"
                            className="min-w-44"
                            placeholder="选择对比版本"
                            allowClear
                            value={compareId || undefined}
                            onChange={(value) => setCompareId(value || "")}
                            options={detail.versions.filter((version) => version.id !== selectedId).map((version) => ({ value: version.id, label: `与 v${version.version} 对比` }))}
                        />
                    </div>
                </div>
                <Alert type="info" showIcon className="!mb-4" title="保存只创建新草稿，不会改变线上版本。" description="激活旧版本即回滚。测试也只使用已保存的版本；未保存编辑不会发送给模型。" />
                {editor && selected ? (
                    <Form layout="vertical" disabled={Boolean(busy)}>
                        {base && (
                            <div className="mb-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                                <span>对照 v{compare?.version}（只读）</span>
                                <span>
                                    当前编辑 v{selected.version} {versionDirty ? "· 未保存" : ""}
                                </span>
                            </div>
                        )}
                        {fields.map(({ key, label, rows }) => (
                            <Form.Item
                                key={key}
                                label={
                                    <span>
                                        {label} {base && base[key] !== editor[key] && <Tag color="orange">有差异</Tag>}
                                    </span>
                                }
                            >
                                <div className={base ? "grid min-w-0 gap-3 xl:grid-cols-2" : "min-w-0"}>
                                    {base && <pre className="max-h-[420px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 text-xs">{base[key] || "（空）"}</pre>}
                                    <Input.TextArea aria-label={label} className="!font-mono !text-xs" rows={rows} value={editor[key]} onChange={(event) => setEditor({ ...editor, [key]: event.target.value })} />
                                </div>
                            </Form.Item>
                        ))}
                        <Form.Item label="输出语言">
                            <Select
                                aria-label="输出语言"
                                className="max-w-64"
                                value={editor.outputLanguage}
                                onChange={(outputLanguage) => setEditor({ ...editor, outputLanguage })}
                                options={[
                                    { value: "en", label: "英文" },
                                    { value: "zh", label: "中文" },
                                ]}
                            />
                            {base && base.outputLanguage !== editor.outputLanguage && (
                                <Tag color="orange" className="ml-2">
                                    对照版本：{base.outputLanguage}
                                </Tag>
                            )}
                        </Form.Item>
                        <div className="flex flex-wrap gap-3">
                            <Button
                                type="primary"
                                loading={busy === "version"}
                                disabled={!versionDirty || Boolean(busy)}
                                onClick={() =>
                                    void run("version", async () => {
                                        const content = parseVersion(editor);
                                        const { version } = await createAdminPromptVersion(detail.recipe.key, content, options());
                                        await refresh();
                                        setSelectedId(version.id);
                                        message.success(`v${version.version} 草稿已保存，尚未激活`);
                                    })
                                }
                            >
                                保存为新版本草稿
                            </Button>
                            <Button
                                disabled={Boolean(busy) || versionDirty || settingsDirty || selected.id === detail.recipe.currentVersionId}
                                loading={busy === "activate"}
                                onClick={() => {
                                    try {
                                        assertFallback(detail.recipe.failurePolicy, selected);
                                    } catch (reason) {
                                        setError(messageOf(reason));
                                        return;
                                    }
                                    modal.confirm({
                                        title: `激活 v${selected.version}？`,
                                        content: "此操作将切换线上配方；选择旧版本可完成回滚。已提交任务不变。",
                                        okText: "确认激活",
                                        cancelText: "取消",
                                        onOk: () =>
                                            run("activate", async () => {
                                                await activateAdminPromptVersion(detail.recipe.key, selected.id, options());
                                                await refresh();
                                                message.success(`已激活 v${selected.version}`);
                                            }),
                                    });
                                }}
                            >
                                {selected.id === detail.recipe.currentVersionId ? "当前线上版本" : "激活此版本 / 回滚"}
                            </Button>
                        </div>
                        <p className="mt-4 break-all text-xs text-muted-foreground">
                            保存时间：{new Date(selected.createdAt).toLocaleString()} · 内容指纹：{selected.contentHash}
                        </p>
                    </Form>
                ) : (
                    <Alert type="warning" title="此配方尚无可编辑版本，请检查服务端种子数据。" />
                )}
            </section>
        </div>
    );
}
