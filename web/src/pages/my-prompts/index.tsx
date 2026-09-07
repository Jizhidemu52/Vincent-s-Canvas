import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Input, Pagination, Select, Spin, Switch } from "antd";
import { useWorkbenchField } from "@/hooks/use-workbench-field";
import { BookOpen, Plus, Search } from "lucide-react";
import { deploymentFeatures } from "@/lib/deployment-features";
import { createPromptListLoader } from "@/lib/prompt-list-loader";

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
    const [loadError, setLoadError] = useState("");
    const [query, setQuery] = useWorkbenchField("my-prompts:query", "");
    const [sort, setSort] = useWorkbenchField<"updated" | "recent" | "used">("my-prompts:sort", "updated");
    const [favorite, setFavorite] = useWorkbenchField("my-prompts:favorite", false);
    const [page, setPage] = useWorkbenchField("my-prompts:page", 1);
    const [pageSize, setPageSize] = useWorkbenchField("my-prompts:pageSize", 24);
    const [total, setTotal] = useState(0);
    const [editing, setEditing] = useState<PromptTemplate | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [loader] = useState(createPromptListLoader);

    const load = useCallback(() => loader.load(
        () => listPromptTemplates({ scope: "personal", query, sort, favorite: favorite ? true : undefined, page, pageSize }),
        (result) => { setItems(result.templates); setTotal(result.total); setPage((value) => Math.min(value, Math.max(1, Math.ceil(result.total / pageSize)))); },
        (error) => setLoadError(error instanceof Error ? error.message : "加载个人提示词失败"),
        (value) => { setLoading(value); if (value) setLoadError(""); },
    ), [favorite, loader, page, pageSize, query, setPage, sort]);

    useEffect(() => {
        const timer = window.setTimeout(() => void load(), 250);
        return () => { window.clearTimeout(timer); loader.invalidate(); };
    }, [load, loader]);

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
        <main className="wb-page h-full overflow-y-auto px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto max-w-7xl">
                <header className="wb-header">
                    <div><p className="wb-eyebrow">个人经验库</p><h1 className="wb-title">我的提示词</h1><p className="wb-description">把好用的创作方法存成模板。点击「仅填入」先检查内容，{deploymentFeatures.creditsEnabled ? "确认积分后" : "确认参数后"}再生成。</p></div>
                    <Button size="large" type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>新建模板</Button>
                </header>
                <section className="wb-toolbar mb-6">
                    <Input className="max-w-md" allowClear prefix={<Search className="size-4 text-stone-400" />} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索名称、提示词或分类" />
                    <Select value={sort} onChange={(value) => { setSort(value); setPage(1); }} options={[{ value: "updated", label: "最近更新" }, { value: "recent", label: "最近使用" }, { value: "used", label: "使用最多" }]} />
                    <label className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300"><Switch size="small" checked={favorite} onChange={(value) => { setFavorite(value); setPage(1); }} />只看收藏</label>
                    <span aria-live="polite" className="ml-auto text-xs text-stone-500">{loading && items.length ? "正在更新 · " : ""}共 {total} 个模板</span>
                </section>
                {loadError ? <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"><span>{loadError}</span><Button onClick={() => void load()}>重新加载</Button></div> : null}
                {loading && !items.length ? <div className="flex min-h-80 items-center justify-center"><Spin /></div> : items.length ? (
                    <section aria-busy={loading} className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map((item) => (
                        <PromptTemplateCard key={item.id} item={item} editable canSubmit={Boolean(groupId)} onReuse={(mode) => reuse(item, mode)}
                            onEdit={() => { setEditing(item); setEditorOpen(true); }}
                            onCopy={async () => { await copyPromptTemplate(item.id); message.success("已复制为新模板"); await load(); }}
                            onFavorite={async () => { await setPromptFavorite(item.id, !item.favorite); await load(); }}
                            onSubmit={async () => { const result = await submitPromptToTeam(item.id); message.success(result.submission.duplicate ? "该请求已提交过" : "已提交组长或管理员审核"); }}
                            onDelete={() => modal.confirm({ title: "删除这个个人模板？", content: "已发布的团队版本不会受影响。", okText: "删除", okButtonProps: { danger: true }, onOk: async () => { await deletePromptTemplate(item.id); message.success("模板已删除"); await load(); } })}
                        />
                    ))}</section>
                ) : !loadError ? <div className="wb-surface wb-empty"><BookOpen className="size-9" /><strong>{query || favorite ? "没有匹配的模板" : "留住一次满意的创作"}</strong><p>{query || favorite ? "换个关键词，或关闭收藏筛选看看。" : "新建模板记录提示词，也可以从生成结果中一键保存。模板仅你本人可管理。"}</p>{query || favorite ? <Button onClick={() => { setQuery(""); setFavorite(false); }}>清除筛选</Button> : <Button type="primary" onClick={() => { setEditing(null); setEditorOpen(true); }}>创建第一个模板</Button>}</div> : null}
                {total > 0 ? <Pagination className="mt-6 flex justify-center" current={page} pageSize={pageSize} total={total} showSizeChanger pageSizeOptions={[24, 48, 96]} onChange={(next, size) => { setPage(size !== pageSize ? 1 : next); setPageSize(size); }} /> : null}
            </div>
            <PromptTemplateEditor open={editorOpen} initial={editing} title={editing ? "编辑个人模板" : "新建个人模板"} onCancel={() => { setEditorOpen(false); setEditing(null); }} onSubmit={save} />
        </main>
    );
}
