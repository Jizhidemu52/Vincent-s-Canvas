import { useUiText } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { App, Button, Input, Pagination, Select, Spin, Switch } from "antd";
import { useWorkbenchField } from "@/hooks/use-workbench-field";
import { BookOpen, Plus, Search } from "lucide-react";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createPromptListLoader } from "@/lib/prompt-list-loader";

import { PromptTemplateCard } from "@/components/prompts/prompt-template-card";
import { PromptTemplateEditor } from "@/components/prompts/prompt-template-editor";
import { usePromptTemplateActions } from "@/components/prompts/use-prompt-template-actions";
import { usePromptFavoriteList } from "@/components/prompts/use-prompt-favorite-list";
import {
    copyPromptTemplate, createPromptTemplate, deletePromptTemplate, listPromptTemplates,
    submitPromptToTeam, updatePromptTemplate,
    type PromptSnapshotInput, type PromptTemplate,
} from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

export default function MyPromptsPage() {
    const t = useUiText();
    const { message, modal } = App.useApp();
    const { reuse, insertToCanvas, canvasDialog } = usePromptTemplateActions();
    const user = useUserStore((state) => state.user);
    const groupId = user?.groupId;
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [query, setQuery] = useWorkbenchField("my-prompts:query", "");
    const [sort, setSort] = useWorkbenchField<"updated" | "recent" | "used">("my-prompts:sort", "updated");
    const [favorite, setFavorite] = useWorkbenchField("my-prompts:favorite", false);
    const [page, setPage] = useWorkbenchField("my-prompts:page", 1);
    const [pageSize, setPageSize] = useWorkbenchField("my-prompts:pageSize", 24);
    const [editing, setEditing] = useState<PromptTemplate | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [loader] = useState(createPromptListLoader);
    const { items, total, accept, waitForPending, onFavorite } = usePromptFavoriteList({
        ownerId: user?.id, viewKey: JSON.stringify([query, sort, favorite, page, pageSize]), page, pageSize, favoriteOnly: favorite, loading, setPage,
        readPage: (nextPage, size) => listPromptTemplates({ scope: "personal", query, sort, favorite: favorite ? true : undefined, page: nextPage, pageSize: size }),
        onRefreshError: setLoadError,
    });

    const load = useCallback(() => loader.load(
        async () => { await waitForPending(); return listPromptTemplates({ scope: "personal", query, sort, favorite: favorite ? true : undefined, page, pageSize }); },
        (result) => { accept(result); setPage((value) => Math.min(value, Math.max(1, Math.ceil(result.total / pageSize)))); },
        (error) => setLoadError(error instanceof Error ? error.message : t("加载个人提示词失败")),
        (value) => { setLoading(value); if (value) setLoadError(""); },
    ), [accept, favorite, loader, page, pageSize, query, setPage, sort, waitForPending]);

    useEffect(() => {
        const timer = window.setTimeout(() => void load(), 250);
        return () => { window.clearTimeout(timer); loader.invalidate(); };
    }, [load, loader]);

    const save = async (input: PromptSnapshotInput) => {
        if (editing) await updatePromptTemplate(editing.id, input); else await createPromptTemplate(input);
        message.success(editing ? t("模板已生成新版本") : t("模板已创建"));
        setEditorOpen(false); setEditing(null); await load();
    };

    return (
        <main className="wb-page h-full overflow-y-auto px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto max-w-7xl">
                <header className="wb-header">
                    <div><p className="wb-eyebrow">{t("个人经验库")}</p><h1 className="wb-title">{t("我的提示词")}</h1><p className="wb-description">{t("发送到生成页仅填入内容，")}{deploymentFeatures.creditsEnabled ? t("确认积分后") : t("确认参数后")}{t("再生成；也可直接插入画布继续编辑。")}</p></div>
                    <Button size="large" type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>{t("新建模板")}</Button>
                </header>
                <section className="wb-toolbar mb-6">
                    <Input className="max-w-md" allowClear prefix={<Search className="size-4 text-stone-400" />} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder={t("搜索名称、提示词或分类")} />
                    <Select value={sort} onChange={(value) => { setSort(value); setPage(1); }} options={[{ value: "updated", label: t("最近更新") }, { value: "recent", label: t("最近使用") }, { value: "used", label: t("使用最多") }]} />
                    <label className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300"><Switch size="small" checked={favorite} onChange={(value) => { setFavorite(value); setPage(1); }} />{t("只看收藏")}</label>
                    <span aria-live="polite" className="ml-auto text-xs text-stone-500">{loading && items.length ? t("正在更新 · ") : ""}{t("共")} {total} {t("个模板")}</span>
                </section>
                {loadError ? <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"><span>{loadError}</span><Button onClick={() => void load()}>{t("重新加载")}</Button></div> : null}
                {loading && !items.length ? <div className="flex min-h-80 items-center justify-center"><Spin /></div> : items.length ? (
                    <section aria-busy={loading} className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map((item) => (
                        <PromptTemplateCard key={item.id} item={item} editable canSubmit={Boolean(groupId)} onReuse={(mode) => reuse(item, mode)} onInsertToCanvas={() => insertToCanvas(item)}
                            onEdit={() => { setEditing(item); setEditorOpen(true); }}
                            onCopy={async () => { await copyPromptTemplate(item.id); message.success(t("已复制为新模板")); await load(); }}
                            onFavorite={() => onFavorite(item)}
                            onSubmit={async () => { const result = await submitPromptToTeam(item.id); message.success(result.submission.duplicate ? t("该请求已提交过") : t("已提交组长或管理员审核")); }}
                            onDelete={() => modal.confirm({ title: t("删除这个个人模板？"), content: t("已发布的团队版本不会受影响。"), okText: t("删除"), okButtonProps: { danger: true }, onOk: async () => { await deletePromptTemplate(item.id); message.success(t("模板已删除")); await load(); } })}
                        />
                    ))}</section>
                ) : !loadError ? <div className="wb-surface wb-empty"><BookOpen className="size-9" /><strong>{query || favorite ? t("没有匹配的模板") : t("留住一次满意的创作")}</strong><p>{query || favorite ? t("换个关键词，或关闭收藏筛选看看。") : t("新建模板记录提示词，也可以从生成结果中一键保存。模板仅你本人可管理。")}</p>{query || favorite ? <Button onClick={() => { setQuery(""); setFavorite(false); }}>{t("清除筛选")}</Button> : <Button type="primary" onClick={() => { setEditing(null); setEditorOpen(true); }}>{t("创建第一个模板")}</Button>}</div> : null}
                {total > 0 ? <Pagination className="mt-6 flex justify-center" current={page} pageSize={pageSize} total={total} showSizeChanger pageSizeOptions={[24, 48, 96]} onChange={(next, size) => { setPage(size !== pageSize ? 1 : next); setPageSize(size); }} /> : null}
            </div>
            <PromptTemplateEditor open={editorOpen} initial={editing} title={editing ? t("编辑个人模板") : t("新建个人模板")} onCancel={() => { setEditorOpen(false); setEditing(null); }} onSubmit={save} />
            {canvasDialog}
        </main>
    );
}
