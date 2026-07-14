import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Empty, Input, Select, Spin, Switch } from "antd";
import { Plus, Search } from "lucide-react";

import { PromptTemplateCard } from "@/components/prompts/prompt-template-card";
import { PromptTemplateEditor } from "@/components/prompts/prompt-template-editor";
import {
    copyPromptTemplate, createPromptTemplate, deletePromptTemplate, listPromptTemplates, promptDestination,
    resolvePromptReuse, setPromptFavorite, submitPromptToTeam, updatePromptTemplate,
    type PromptSnapshotInput, type PromptTemplate,
} from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

export default function MyPromptsPage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const groupId = useUserStore((state) => state.user?.groupId);
    const [items, setItems] = useState<PromptTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<"updated" | "recent" | "used">("updated");
    const [favorite, setFavorite] = useState(false);
    const [editing, setEditing] = useState<PromptTemplate | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listPromptTemplates({ scope: "personal", query, sort, favorite: favorite ? true : undefined, pageSize: 100 });
            setItems(result.templates);
        } catch (error) { message.error(error instanceof Error ? error.message : "加载个人提示词失败"); }
        finally { setLoading(false); }
    }, [favorite, message, query, sort]);

    useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);

    const save = async (input: PromptSnapshotInput) => {
        if (editing) await updatePromptTemplate(editing.id, input); else await createPromptTemplate(input);
        message.success(editing ? "模板已生成新版本" : "模板已创建");
        setEditorOpen(false); setEditing(null); await load();
    };
    const reuse = async (item: PromptTemplate, mode: "fill" | "fill_and_generate") => {
        try {
            const result = await resolvePromptReuse(item.id, mode);
            if (result.pricing.modelChanged) message.warning(result.pricing.selectedModel ? `原模型已变更，将使用 ${result.pricing.selectedModel.name}` : "原模型已变更，请在目标页选择当前可用模型");
            navigate(promptDestination(item.targetTool, result.reuseToken));
        } catch (error) { message.error(error instanceof Error ? error.message : "复用失败"); }
    };

    return (
        <main className="h-full overflow-y-auto bg-[#f6f6f4] px-5 py-8 text-stone-950 dark:bg-stone-950 dark:text-white">
            <div className="mx-auto max-w-7xl">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div><p className="text-xs font-semibold text-orange-600">个人经验</p><h1 className="mt-2 text-3xl font-semibold">我的提示词</h1><p className="mt-2 text-sm text-stone-500">仅你本人可管理。复用默认只填入，确认当前积分后才会生成。</p></div>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>新建模板</Button>
                </header>
                <section className="my-6 flex flex-wrap items-center gap-3">
                    <Input className="max-w-md" allowClear prefix={<Search className="size-4 text-stone-400" />} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、提示词或分类" />
                    <Select value={sort} onChange={setSort} options={[{ value: "updated", label: "最近更新" }, { value: "recent", label: "最近使用" }, { value: "used", label: "使用最多" }]} />
                    <label className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300"><Switch size="small" checked={favorite} onChange={setFavorite} />只看收藏</label>
                    <span className="ml-auto text-xs text-stone-500">共 {items.length} 个模板</span>
                </section>
                {loading ? <div className="flex min-h-80 items-center justify-center"><Spin /></div> : items.length ? (
                    <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map((item) => (
                        <PromptTemplateCard key={item.id} item={item} editable canSubmit={Boolean(groupId)} onReuse={(mode) => void reuse(item, mode)}
                            onEdit={() => { setEditing(item); setEditorOpen(true); }}
                            onCopy={async () => { await copyPromptTemplate(item.id); message.success("已复制为新模板"); await load(); }}
                            onFavorite={async () => { await setPromptFavorite(item.id, !item.favorite); await load(); }}
                            onSubmit={async () => { const result = await submitPromptToTeam(item.id); message.success(result.submission.duplicate ? "该请求已提交过" : "已提交组长或管理员审核"); }}
                            onDelete={() => modal.confirm({ title: "删除这个个人模板？", content: "已发布的团队版本不会受影响。", okText: "删除", okButtonProps: { danger: true }, onOk: async () => { await deletePromptTemplate(item.id); message.success("模板已删除"); await load(); } })}
                        />
                    ))}</section>
                ) : <Empty className="py-24" description="还没有个人模板" />}
            </div>
            <PromptTemplateEditor open={editorOpen} initial={editing} title={editing ? "编辑个人模板" : "新建个人模板"} onCancel={() => { setEditorOpen(false); setEditing(null); }} onSubmit={save} />
        </main>
    );
}
