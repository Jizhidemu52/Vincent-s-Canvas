import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Empty, Input, Modal, Segmented, Spin, Tag } from "antd";
import { Check, Plus, Search, X } from "lucide-react";

import { PromptTemplateCard } from "@/components/prompts/prompt-template-card";
import { PromptTemplateEditor } from "@/components/prompts/prompt-template-editor";
import {
    archiveSharedPrompt, copyPromptTemplate, createPublicPrompt, listPromptSubmissions, listPromptTemplates,
    promotePromptPublic, promptDestination, resolvePromptReuse, reviewPromptSubmission, setPromptFavorite, updatePublicPrompt,
    type PromptSnapshotInput, type PromptSubmission, type PromptTemplate,
} from "@/services/api/prompts";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

export default function PromptsPage() {
    const { message, modal } = App.useApp(); const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const [scope, setScope] = useState<"team" | "public">(user?.groupId ? "team" : "public");
    const [items, setItems] = useState<PromptTemplate[]>([]); const [submissions, setSubmissions] = useState<PromptSubmission[]>([]);
    const [query, setQuery] = useState(""); const [loading, setLoading] = useState(true);
    const [editorOpen, setEditorOpen] = useState(false); const [editing, setEditing] = useState<PromptTemplate | null>(null);
    const canReview = user?.groupRole === "leader" || isAdminRole(user?.role); const isSuper = user?.role === "super_admin";

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [templates, queue] = await Promise.all([listPromptTemplates({ scope, query, pageSize: 100 }), canReview ? listPromptSubmissions() : Promise.resolve({ submissions: [] })]);
            setItems(templates.templates); setSubmissions(queue.submissions.filter((item) => item.status === "pending"));
        } catch (error) { message.error(error instanceof Error ? error.message : "加载提示词库失败"); }
        finally { setLoading(false); }
    }, [canReview, message, query, scope]);
    useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);

    const reuse = async (item: PromptTemplate, mode: "fill" | "fill_and_generate") => {
        try { const result = await resolvePromptReuse(item.id, mode); if (result.pricing.modelChanged) message.warning(result.pricing.selectedModel ? `模型已变更，当前使用 ${result.pricing.selectedModel.name}` : "模型已变更，请在目标页选择替代模型"); navigate(promptDestination(item.targetTool, result.reuseToken)); }
        catch (error) { message.error(error instanceof Error ? error.message : "复用失败"); }
    };
    const savePublic = async (input: PromptSnapshotInput) => { if (editing) await updatePublicPrompt(editing.id, input); else await createPublicPrompt(input); message.success(editing ? "公共模板已生成新版本" : "公共模板已发布"); setEditorOpen(false); setEditing(null); await load(); };

    return (
        <main className="h-full overflow-y-auto bg-[#f6f6f4] px-5 py-8 text-stone-950 dark:bg-stone-950 dark:text-white">
            <div className="mx-auto max-w-7xl">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div><p className="text-xs font-semibold text-orange-600">共享经验</p><h1 className="mt-2 text-3xl font-semibold">提示词库</h1><p className="mt-2 text-sm text-stone-500">团队内容经过组内审核，公共内容由管理员统一维护。</p></div>
                    {isSuper && scope === "public" ? <Button type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>新建公共模板</Button> : null}
                </header>
                <section className="my-6 flex flex-wrap items-center gap-3">
                    <Segmented value={scope} onChange={(value) => setScope(value as "team" | "public")} options={[...(user?.groupId || isAdminRole(user?.role) ? [{ value: "team", label: "团队提示词" }] : []), { value: "public", label: "公共提示词库" }]} />
                    <Input className="max-w-md" allowClear prefix={<Search className="size-4 text-stone-400" />} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、完整提示词或分类" />
                    <span className="ml-auto text-xs text-stone-500">共 {items.length} 个已发布模板</span>
                </section>
                {canReview && scope === "team" && submissions.length ? (
                    <section className="mb-7 border-y border-orange-200 bg-orange-50/70 py-4 dark:border-orange-900 dark:bg-orange-950/20">
                        <div className="mb-3 flex items-center gap-2 px-4"><h2 className="text-sm font-semibold">待审核模板</h2><Tag color="orange">{submissions.length}</Tag></div>
                        <div className="grid gap-3 px-4 md:grid-cols-2">{submissions.map((item) => <div key={item.id} className="rounded-lg border border-orange-200 bg-white p-4 dark:border-orange-900 dark:bg-stone-950"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{item.title}</h3><p className="mt-1 text-xs text-stone-500">提交人：{item.submitterName}</p></div><div className="flex gap-1"><Button size="small" type="primary" icon={<Check className="size-3.5" />} onClick={() => modal.confirm({ title: "通过并发布到本组？", content: "将形成独立团队版本，个人后续修改不会覆盖它。", onOk: async () => { await reviewPromptSubmission(item.id, "approve", "审核通过"); message.success("团队模板已发布"); await load(); } })}>通过</Button><Button size="small" danger icon={<X className="size-3.5" />} onClick={() => openReject(item, modal, message, load)}>驳回</Button></div></div><p className="mt-3 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-300">{item.prompt}</p></div>)}</div>
                    </section>
                ) : null}
                {loading ? <div className="flex min-h-80 items-center justify-center"><Spin /></div> : items.length ? <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map((item) => <PromptTemplateCard key={item.id} item={item} editable={isSuper && item.scope === "public"} onReuse={(mode) => void reuse(item, mode)} onCopy={async () => { await copyPromptTemplate(item.id); message.success("已复制到我的提示词"); }} onFavorite={async () => { await setPromptFavorite(item.id, !item.favorite); await load(); }} onEdit={isSuper && item.scope === "public" ? () => { setEditing(item); setEditorOpen(true); } : undefined} onPromote={isSuper && item.scope === "team" ? async () => { await promotePromptPublic(item.id); message.success("已发布到公共提示词库"); } : undefined} onArchive={isAdminRole(user?.role) ? () => modal.confirm({ title: "下架这个共享模板？", onOk: async () => { await archiveSharedPrompt(item.id); message.success("模板已下架"); await load(); } }) : undefined} />)}</section> : <Empty className="py-24" description={scope === "team" ? "本组暂无已发布模板" : "暂无公共模板"} />}
            </div>
            <PromptTemplateEditor open={editorOpen} initial={editing} title={editing ? "编辑公共模板" : "新建公共模板"} onCancel={() => { setEditorOpen(false); setEditing(null); }} onSubmit={savePublic} />
        </main>
    );
}

function openReject(item: PromptSubmission, modal: ReturnType<typeof App.useApp>["modal"], message: ReturnType<typeof App.useApp>["message"], reload: () => Promise<void>) {
    let note = "";
    modal.confirm({ title: `驳回“${item.title}”`, content: <Input.TextArea rows={4} maxLength={1_000} placeholder="填写修改建议" onChange={(event) => { note = event.target.value; }} />, okText: "确认驳回", okButtonProps: { danger: true }, onOk: async () => { await reviewPromptSubmission(item.id, "reject", note); message.success("已驳回并保留审核意见"); await reload(); } });
}
