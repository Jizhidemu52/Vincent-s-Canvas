import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Empty, Input, Modal, Segmented, Spin, Tag } from "antd";
import { BookOpen, Check, Plus, Search, X } from "lucide-react";

import { PromptTemplateCard } from "@/components/prompts/prompt-template-card";
import { PromptTemplateEditor } from "@/components/prompts/prompt-template-editor";
import {
    archiveSharedPrompt, copyPromptTemplate, createPublicPrompt, listPromptSubmissions, listPromptTemplates,
    promotePromptPublic, promptDestination, resolvePromptReuse, reviewPromptSubmission, setPromptFavorite, updatePublicPrompt,
    type PromptSnapshotInput, type PromptSubmission, type PromptTemplate,
} from "@/services/api/prompts";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";
import { createPromptListLoader } from "@/lib/prompt-list-loader";

export default function PromptsPage() {
    const { message, modal } = App.useApp(); const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const [scope, setScope] = useState<"team" | "public">(user?.groupId ? "team" : "public");
    const [items, setItems] = useState<PromptTemplate[]>([]); const [submissions, setSubmissions] = useState<PromptSubmission[]>([]);
    const [query, setQuery] = useState(""); const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [editorOpen, setEditorOpen] = useState(false); const [editing, setEditing] = useState<PromptTemplate | null>(null);
    const [loader] = useState(createPromptListLoader);
    const canReview = user?.groupRole === "leader" || isAdminRole(user?.role); const isSuper = user?.role === "super_admin";

    const load = useCallback(() => loader.load(
        () => Promise.all([listPromptTemplates({ scope, query, pageSize: 100 }), canReview ? listPromptSubmissions() : Promise.resolve({ submissions: [] })]),
        ([templates, queue]) => { setItems(templates.templates); setSubmissions(queue.submissions.filter((item) => item.status === "pending")); },
        (error) => setLoadError(error instanceof Error ? error.message : "加载提示词库失败"),
        (value) => { setLoading(value); if (value) setLoadError(""); },
    ), [canReview, loader, message, query, scope]);
    useEffect(() => {
        const timer = window.setTimeout(() => void load(), 250);
        return () => { window.clearTimeout(timer); loader.invalidate(); };
    }, [load, loader]);

    const reuse = async (item: PromptTemplate, mode: "fill" | "fill_and_generate") => {
        try { const result = await resolvePromptReuse(item.id, mode); if (result.pricing.modelChanged) message.warning(result.pricing.selectedModel ? `模型已变更，当前使用 ${result.pricing.selectedModel.name}` : "模型已变更，请在目标页选择替代模型"); navigate(promptDestination(item.targetTool, result.reuseToken)); }
        catch (error) { message.error(error instanceof Error ? error.message : "复用失败"); }
    };
    const savePublic = async (input: PromptSnapshotInput) => { if (editing) await updatePublicPrompt(editing.id, input); else await createPublicPrompt(input); message.success(editing ? "公共模板已生成新版本" : "公共模板已发布"); setEditorOpen(false); setEditing(null); await load(); };

    return (
        <main className="wb-page h-full overflow-y-auto px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto max-w-7xl">
                <header className="wb-header">
                    <div><p className="wb-eyebrow">共享经验库</p><h1 className="wb-title">提示词库</h1><p className="wb-description">从验证过的模板开始创作。先填入、再调整；团队模板经过审核，公共模板由管理员维护。</p></div>
                    {isSuper && scope === "public" ? <Button size="large" type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>新建公共模板</Button> : <Button size="large" onClick={() => navigate("/my-prompts")}>我的提示词</Button>}
                </header>
                <section className="wb-toolbar mb-6">
                    <Segmented value={scope} onChange={(value) => setScope(value as "team" | "public")} options={[...(user?.groupId || isAdminRole(user?.role) ? [{ value: "team", label: "团队提示词" }] : []), { value: "public", label: "公共提示词库" }]} />
                    <Input className="max-w-md" allowClear prefix={<Search className="size-4 text-stone-400" />} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、完整提示词或分类" />
                    <span aria-live="polite" className="ml-auto text-xs text-stone-500">{loading && items.length ? "正在更新 · " : ""}共 {items.length} 个已发布模板</span>
                </section>
                {loadError ? <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"><span>{loadError}</span><Button onClick={() => void load()}>重新加载</Button></div> : null}
                {canReview && scope === "team" && submissions.length ? (
                    <section className="mb-7 border-y border-orange-200 bg-orange-50/70 py-4 dark:border-orange-900 dark:bg-orange-950/20">
                        <div className="mb-3 flex items-center gap-2 px-4"><h2 className="text-sm font-semibold">待审核模板</h2><Tag color="orange">{submissions.length}</Tag></div>
                        <div className="grid gap-3 px-4 md:grid-cols-2">{submissions.map((item) => <div key={item.id} className="rounded-lg border border-orange-200 bg-white p-4 dark:border-orange-900 dark:bg-stone-950"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{item.title}</h3><p className="mt-1 text-xs text-stone-500">提交人：{item.submitterName}</p></div><div className="flex gap-1"><Button size="small" type="primary" icon={<Check className="size-3.5" />} onClick={() => modal.confirm({ title: "通过并发布到本组？", content: "将形成独立团队版本，个人后续修改不会覆盖它。", onOk: async () => { await reviewPromptSubmission(item.id, "approve", "审核通过"); message.success("团队模板已发布"); await load(); } })}>通过</Button><Button size="small" danger icon={<X className="size-3.5" />} onClick={() => openReject(item, modal, message, load)}>驳回</Button></div></div><p className="mt-3 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-300">{item.prompt}</p></div>)}</div>
                    </section>
                ) : null}
                {loading && !items.length ? <div className="flex min-h-80 items-center justify-center"><Spin /></div> : items.length ? <section aria-busy={loading} className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map((item) => <PromptTemplateCard key={item.id} item={item} editable={isSuper && item.scope === "public"} onReuse={(mode) => void reuse(item, mode)} onCopy={async () => { await copyPromptTemplate(item.id); message.success("已复制到我的提示词"); }} onFavorite={async () => { await setPromptFavorite(item.id, !item.favorite); await load(); }} onEdit={isSuper && item.scope === "public" ? () => { setEditing(item); setEditorOpen(true); } : undefined} onPromote={isSuper && item.scope === "team" ? async () => { await promotePromptPublic(item.id); message.success("已发布到公共提示词库"); } : undefined} onArchive={isAdminRole(user?.role) ? () => modal.confirm({ title: "下架这个共享模板？", onOk: async () => { await archiveSharedPrompt(item.id); message.success("模板已下架"); await load(); } }) : undefined} />)}</section> : !loadError ? <div className="wb-surface wb-empty"><BookOpen className="size-9" /><strong>{query ? "没有找到匹配模板" : scope === "team" ? "团队经验，等你来分享" : "公共模板正在整理中"}</strong><p>{query ? "试试更短的关键词，或清除搜索查看全部内容。" : "先把好用的方法保存到我的提示词，需要时再复用或提交给团队。"}</p>{query ? <Button onClick={() => setQuery("")}>清除搜索</Button> : <Button onClick={() => navigate("/my-prompts")}>查看我的提示词</Button>}</div> : null}
            </div>
            <PromptTemplateEditor open={editorOpen} initial={editing} title={editing ? "编辑公共模板" : "新建公共模板"} onCancel={() => { setEditorOpen(false); setEditing(null); }} onSubmit={savePublic} />
        </main>
    );
}

function openReject(item: PromptSubmission, modal: ReturnType<typeof App.useApp>["modal"], message: ReturnType<typeof App.useApp>["message"], reload: () => Promise<void>) {
    let note = "";
    modal.confirm({ title: `驳回“${item.title}”`, content: <Input.TextArea rows={4} maxLength={1_000} placeholder="填写修改建议" onChange={(event) => { note = event.target.value; }} />, okText: "确认驳回", okButtonProps: { danger: true }, onOk: async () => { await reviewPromptSubmission(item.id, "reject", note); message.success("已驳回并保留审核意见"); await reload(); } });
}
