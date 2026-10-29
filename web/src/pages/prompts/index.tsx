import { useUiText, uiText } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Input, Pagination, Segmented, Spin, Tag } from "antd";
import { useWorkbenchField } from "@/hooks/use-workbench-field";
import { BookOpen, Check, Plus, Search, X } from "lucide-react";

import { PromptTemplateCard } from "@/components/prompts/prompt-template-card";
import { PromptTemplateEditor } from "@/components/prompts/prompt-template-editor";
import { usePromptTemplateActions } from "@/components/prompts/use-prompt-template-actions";
import { usePromptFavoriteList } from "@/components/prompts/use-prompt-favorite-list";
import {
    archiveSharedPrompt, copyPromptTemplate, createPublicPrompt, listPromptSubmissions, listPromptTemplates,
    promotePromptPublic, reviewPromptSubmission, updatePublicPrompt,
    type PromptSnapshotInput, type PromptSubmission, type PromptTemplate,
} from "@/services/api/prompts";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { createPromptListLoader } from "@/lib/prompt-list-loader";

export default function PromptsPage() {
    const t = useUiText();
    const { message, modal } = App.useApp(); const navigate = useNavigate();
    const { reuse, insertToCanvas, canvasDialog } = usePromptTemplateActions();
    const user = useUserStore((state) => state.user);
    const [storedScope, setScope] = useWorkbenchField<"team" | "public">("prompts:scope", user?.groupId ? "team" : "public");
    const canAccessTeam = Boolean(user?.groupId) || isAdminRole(user?.role);
    const scope = storedScope === "team" && !canAccessTeam ? "public" : storedScope;
    const [submissions, setSubmissions] = useState<PromptSubmission[]>([]);
    const [query, setQuery] = useWorkbenchField("prompts:query", ""); const [loading, setLoading] = useState(true);
    const [page, setPage] = useWorkbenchField("prompts:page", 1);
    const [pageSize, setPageSize] = useWorkbenchField("prompts:pageSize", 24);
    const [loadError, setLoadError] = useState("");
    const [editorOpen, setEditorOpen] = useState(false); const [editing, setEditing] = useState<PromptTemplate | null>(null);
    const [loader] = useState(createPromptListLoader);
    const canReview = user?.groupRole === "leader" || isAdminRole(user?.role); const isSuper = user?.role === "super_admin";
    const { items, total, accept, waitForPending, onFavorite } = usePromptFavoriteList({
        ownerId: user?.id, viewKey: JSON.stringify([scope, query, page, pageSize]), page, pageSize, loading, setPage,
        readPage: (nextPage, size) => listPromptTemplates({ scope, query, page: nextPage, pageSize: size }), onRefreshError: setLoadError,
    });

    const load = useCallback(() => loader.load(
        async () => { await waitForPending(); return Promise.all([listPromptTemplates({ scope, query, page, pageSize }), canReview ? listPromptSubmissions() : Promise.resolve({ submissions: [] })]); },
        ([templates, queue]) => { accept(templates); setPage((value) => Math.min(value, Math.max(1, Math.ceil(templates.total / pageSize)))); setSubmissions(queue.submissions.filter((item) => item.status === "pending")); },
        (error) => setLoadError(error instanceof Error ? error.message : t("加载提示词库失败")),
        (value) => { setLoading(value); if (value) setLoadError(""); },
    ), [accept, canReview, loader, page, pageSize, query, scope, setPage, waitForPending]);
    useEffect(() => {
        const timer = window.setTimeout(() => void load(), 250);
        return () => { window.clearTimeout(timer); loader.invalidate(); };
    }, [load, loader]);

    const savePublic = async (input: PromptSnapshotInput) => { if (editing) await updatePublicPrompt(editing.id, input); else await createPublicPrompt(input); message.success(editing ? t("公共模板已生成新版本") : t("公共模板已发布")); setEditorOpen(false); setEditing(null); await load(); };

    return (
        <main className="wb-page h-full overflow-y-auto px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto max-w-7xl">
                <header className="wb-header">
                    <div><p className="wb-eyebrow">{t("共享经验库")}</p><h1 className="wb-title">{t("提示词库")}</h1><p className="wb-description">{t("从验证过的模板开始创作。先填入、再调整；团队模板经过审核，公共模板由管理员维护。")}</p></div>
                    {isSuper && scope === "public" ? <Button size="large" type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>{t("新建公共模板")}</Button> : <Button size="large" onClick={() => navigate("/my-prompts")}>{t("我的提示词")}</Button>}
                </header>
                <section className="wb-toolbar mb-6">
                    <Segmented value={scope} onChange={(value) => { setScope(value as "team" | "public"); setPage(1); }} options={[...(canAccessTeam ? [{ value: "team", label: t("团队提示词") }] : []), { value: "public", label: t("公共提示词库") }]} />
                    <Input className="max-w-md" allowClear prefix={<Search className="size-4 text-stone-400" />} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder={t("搜索标题、完整提示词或分类")} />
                    <span aria-live="polite" className="ml-auto text-xs text-stone-500">{loading && items.length ? t("正在更新 · ") : ""}{t("共")} {total} {t("个已发布模板")}</span>
                </section>
                {loadError ? <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"><span>{loadError}</span><Button onClick={() => void load()}>{t("重新加载")}</Button></div> : null}
                {canReview && scope === "team" && submissions.length ? (
                    <section className="mb-7 border-y border-orange-200 bg-orange-50/70 py-4 dark:border-orange-900 dark:bg-orange-950/20">
                        <div className="mb-3 flex items-center gap-2 px-4"><h2 className="text-sm font-semibold">{t("待审核模板")}</h2><Tag color="orange">{submissions.length}</Tag></div>
                        <div className="grid gap-3 px-4 md:grid-cols-2">{submissions.map((item) => <div key={item.id} className="rounded-lg border border-orange-200 bg-white p-4 dark:border-orange-900 dark:bg-stone-950"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{item.title}</h3><p className="mt-1 text-xs text-stone-500">{t("提交人：")}{item.submitterName}</p></div><div className="flex gap-1"><Button size="small" type="primary" icon={<Check className="size-3.5" />} onClick={() => modal.confirm({ title: t("通过并发布到本组？"), content: t("将形成独立团队版本，个人后续修改不会覆盖它。"), onOk: async () => { await reviewPromptSubmission(item.id, "approve", t("审核通过")); message.success(t("团队模板已发布")); await load(); } })}>{t("通过")}</Button><Button size="small" danger icon={<X className="size-3.5" />} onClick={() => openReject(item, modal, message, load)}>{t("驳回")}</Button></div></div><p className="mt-3 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-300">{item.prompt}</p></div>)}</div>
                    </section>
                ) : null}
                {loading && !items.length ? <div className="flex min-h-80 items-center justify-center"><Spin /></div> : items.length ? <section aria-busy={loading} className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map((item) => <PromptTemplateCard key={item.id} item={item} editable={isSuper && item.scope === "public"} onReuse={(mode) => reuse(item, mode)} onInsertToCanvas={() => insertToCanvas(item)} onCopy={async () => { await copyPromptTemplate(item.id); message.success(t("已复制到我的提示词")); }} onFavorite={() => onFavorite(item)} onEdit={isSuper && item.scope === "public" ? () => { setEditing(item); setEditorOpen(true); } : undefined} onPromote={isSuper && item.scope === "team" ? async () => { await promotePromptPublic(item.id); message.success(t("已发布到公共提示词库")); } : undefined} onArchive={isAdminRole(user?.role) ? () => modal.confirm({ title: t("下架这个共享模板？"), onOk: async () => { await archiveSharedPrompt(item.id); message.success(t("模板已下架")); await load(); } }) : undefined} />)}</section> : !loadError ? <div className="wb-surface wb-empty"><BookOpen className="size-9" /><strong>{query ? t("没有找到匹配模板") : scope === "team" ? t("团队经验，等你来分享") : t("公共模板正在整理中")}</strong><p>{query ? t("试试更短的关键词，或清除搜索查看全部内容。") : t("先把好用的方法保存到我的提示词，需要时再复用或提交给团队。")}</p>{query ? <Button onClick={() => setQuery("")}>{t("清除搜索")}</Button> : <Button onClick={() => navigate("/my-prompts")}>{t("查看我的提示词")}</Button>}</div> : null}
                {total > 0 ? <Pagination className="mt-6 flex justify-center" current={page} pageSize={pageSize} total={total} showSizeChanger pageSizeOptions={[24, 48, 96]} onChange={(next, size) => { setPage(size !== pageSize ? 1 : next); setPageSize(size); }} /> : null}
            </div>
            <PromptTemplateEditor open={editorOpen} initial={editing} title={editing ? t("编辑公共模板") : t("新建公共模板")} onCancel={() => { setEditorOpen(false); setEditing(null); }} onSubmit={savePublic} />
            {canvasDialog}
        </main>
    );
}

function openReject(item: PromptSubmission, modal: ReturnType<typeof App.useApp>["modal"], message: ReturnType<typeof App.useApp>["message"], reload: () => Promise<void>) {
    let note = "";
    modal.confirm({ title: uiText("驳回“{p0}”", { p0: String(item.title) }), content: <Input.TextArea rows={4} maxLength={1_000} placeholder={uiText("填写修改建议")} onChange={(event) => { note = event.target.value; }} />, okText: uiText("确认驳回"), okButtonProps: { danger: true }, onOk: async () => { await reviewPromptSubmission(item.id, "reject", note); message.success(uiText("已驳回并保留审核意见")); await reload(); } });
}
