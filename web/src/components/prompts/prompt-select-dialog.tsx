import { useUiLocale, useUiText } from "@/lib/i18n";
import { Check, Plus, Search } from "lucide-react";
import { type UIEvent, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Select, Spin, Tag } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { DisplayText, useDisplayText } from "@/hooks/use-display-text";

import { ALL_PROMPTS_OPTION, createPromptTemplate, type Prompt, type PromptLibraryScope, type PromptSnapshotInput } from "@/services/api/prompts";
import { cn } from "@/lib/utils";
import { createPromptActionGuard } from "@/lib/prompt-template-reuse";
import { PromptCard } from "./prompt-card";
import { PromptTemplateEditor } from "./prompt-template-editor";
import { promptLibrarySourceLabels } from "./prompt-library-data";
import { usePromptList } from "./use-prompt-list";

export function PromptSelectDialog({ open, onOpenChange, onSelect, onSelectTemplate }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (prompt: string) => void; onSelectTemplate?: (templateId: string) => Promise<void> }) {
    const t = useUiText();
    const display = useDisplayText();
    const locale = useUiLocale();
    const { message } = App.useApp();
    const client = useQueryClient();
    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [selecting, setSelecting] = useState(false);
    const [scope, setScope] = useState<PromptLibraryScope>("all");
    const [editorOpen, setEditorOpen] = useState(false);
    const { query, items, identity, authorized, tags: promptTags, categories: promptCategories } = usePromptList({ keyword, tags: selectedTags, category: selectedCategory, scope, enabled: open });
    const view = useRef({ open, identity });
    view.current = { open, identity };
    const changeScope = (next: PromptLibraryScope) => { setScope(next); setSelectedTags([]); setSelectedCategory(ALL_PROMPTS_OPTION); };
    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };
    const selectPrompt = async (item: Prompt, complete = false) => {
        if (selecting) return;
        setSelecting(true);
        const guard = createPromptActionGuard(identity, () => view.current.open && view.current.identity === identity && authorized);
        try {
            guard.assert();
            if (complete && item.templateId && onSelectTemplate) await onSelectTemplate(item.templateId);
            else onSelect(item.prompt);
            guard.assert();
            onOpenChange(false);
        } catch (error) { if (guard.current()) message.error(<DisplayText text={error instanceof Error ? error.message : t("模板加载失败，请重试")} />); }
        finally { guard.dispose(); setSelecting(false); }
    };

    const savePersonal = async (input: PromptSnapshotInput) => {
        const guard = createPromptActionGuard(identity, () => view.current.open && view.current.identity === identity && authorized);
        try {
            guard.assert();
            await createPromptTemplate(input);
            guard.assert();
            await client.invalidateQueries({ queryKey: ["prompts", identity] });
            guard.assert();
            setEditorOpen(false); setKeyword(""); changeScope("personal");
            message.success(t("已保存到我的提示词，仅你本人可见，可在此再次选择"));
        } finally { guard.dispose(); }
    };

    useEffect(() => { setEditorOpen(false); setSelecting(false); }, [identity, open]);
    // Filter labels belong to the selected catalog language. Keep the user's
    // search/draft text intact while clearing obsolete translated filters.
    useEffect(() => { setSelectedTags([]); setSelectedCategory(ALL_PROMPTS_OPTION); }, [locale]);
    useEffect(() => {
        if (open && query.isError) message.error(<DisplayText text={query.error instanceof Error ? query.error.message : t("获取提示词失败")} />);
    }, [message, open, query.error, query.isError]);

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <><Modal title={t("提示词库")} open={open} onCancel={() => { if (!selecting) onOpenChange(false); }} footer={null} width={1040} centered>
            <div data-canvas-no-zoom onWheelCapture={(event) => event.stopPropagation()}>
                <div className="flex flex-wrap gap-3">
                    <Select<PromptLibraryScope> aria-label={t("提示词来源")} virtual={false} value={scope} onChange={changeScope} className="min-w-36" options={Object.entries(promptLibrarySourceLabels).map(([value, label]) => ({ value: value as PromptLibraryScope, label: t(label) }))} />
                    <Input className="min-w-44 flex-1" prefix={<Search className="size-4 text-stone-400" />} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t("搜索标题、完整提示词或分类")} />
                    <Button icon={<Plus className="size-4" />} disabled={!authorized || selecting} onClick={() => setEditorOpen(true)}>{t("新增个人提示词")}</Button>
                </div>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("使用提示词只填入文字，保留当前模型、参数和参考图，不会自动生成。完整模板需单独选择。")}</p>
                {query.isError ? <Alert className="mt-3" type="warning" showIcon message={t("个人或共享提示词暂时加载失败，通用提示词仍可使用")} action={<Button size="small" onClick={() => void query.refetch()}>{t("重新加载")}</Button>} /> : null}
                <div className="mt-5 grid gap-3">
                    <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                        <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">{t("分类")}</div>
                        <div className="flex flex-wrap gap-2">
                            {promptCategories.map((category) => (
                                <Tag.CheckableTag key={category} checked={selectedCategory === category} className={cn("prompt-filter-tag", selectedCategory === category && "is-active")} onChange={() => setSelectedCategory(category)}>
                                    {category === ALL_PROMPTS_OPTION ? t(ALL_PROMPTS_OPTION) : display(category)}
                                </Tag.CheckableTag>
                            ))}
                        </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-start">
                        <div className="pt-2 text-xs font-medium text-stone-500 dark:text-stone-400">{t("标签")}</div>
                        <div className="flex flex-wrap gap-2">
                            {promptTags.map((tag) => {
                                const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                return (
                                    <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>
                                        {tag === ALL_PROMPTS_OPTION ? t(ALL_PROMPTS_OPTION) : display(tag)}
                                    </Tag.CheckableTag>
                                );
                            })}
                        </div>
                    </div>
                </div>
                <div className="thin-scrollbar mt-6 max-h-[520px] overflow-y-auto pr-2" data-canvas-no-zoom onScroll={handleListScroll} onWheelCapture={(event) => event.stopPropagation()}>
                    {query.isLoading ? (
                        <div className="flex h-40 items-center justify-center">
                            <Spin />
                        </div>
                    ) : null}
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {items.map((item) => <div key={item.id} data-prompt-library-id={item.id} data-prompt-library-scope={item.scope}>
                            <Tag>{t(promptLibrarySourceLabels[item.scope])}</Tag>
                            <PromptCard item={item} onOpen={() => void selectPrompt(item)} onCopy={() => void selectPrompt(item)} actionLabel={t(selecting ? "正在读取模板…" : "使用此提示词")} actionIcon={<Check className="size-3.5" />} actionType="primary" extraAction={item.templateId && onSelectTemplate ? <Button size="small" disabled={selecting || !authorized} onClick={() => void selectPrompt(item, true)}>{t("套用完整模板")}</Button> : undefined} />
                        </div>)}
                    </div>
                    {!query.isLoading && items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("没有找到匹配的提示词")} className="py-8" /> : null}
                    {query.isFetchingNextPage ? (
                        <div className="py-4 text-center">
                            <Spin size="small" />
                        </div>
                    ) : null}
                    {query.hasNextPage && !query.isFetchingNextPage ? <div className="py-4 text-center"><Button onClick={() => void query.fetchNextPage()}>{t("加载更多提示词")}</Button></div> : null}
                </div>
            </div>
        </Modal><PromptTemplateEditor open={open && editorOpen} title={t("新增个人提示词")} onCancel={() => setEditorOpen(false)} onSubmit={savePersonal} /></>
    );
}
