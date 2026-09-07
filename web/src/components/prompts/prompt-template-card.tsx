import { Button, Dropdown, Tag, Tooltip } from "antd";
import { Archive, Copy, Edit3, Ellipsis, Heart, Play, Send, Share2, Trash2 } from "lucide-react";

import { promptTargetLabels, type PromptTemplate } from "@/services/api/prompts";
import { useAsyncAction } from "@/hooks/use-async-action";

export function PromptTemplateCard({ item, editable, canSubmit, onReuse, onEdit, onCopy, onDelete, onFavorite, onSubmit, onPromote, onArchive }: {
    item: PromptTemplate; editable?: boolean; canSubmit?: boolean;
    onReuse: (mode: "fill" | "fill_and_generate") => void | Promise<void>;
    onEdit?: () => void; onCopy: () => void | Promise<void>; onDelete?: () => void; onFavorite: () => void | Promise<void>; onSubmit?: () => void | Promise<void>; onPromote?: () => void | Promise<void>; onArchive?: () => void;
}) {
    const { pending, run } = useAsyncAction(`prompt-card:${item.id}`);
    const menu = [
        { key: "generate", label: "填入并生成", icon: <Play className="size-4" />, onClick: () => void run(() => onReuse("fill_and_generate")) },
        { key: "copy", label: "复制为我的模板", icon: <Copy className="size-4" />, onClick: () => void run(onCopy) },
        ...(canSubmit && onSubmit ? [{ key: "submit", label: "提交为团队模板", icon: <Send className="size-4" />, onClick: () => void run(onSubmit) }] : []),
        ...(onPromote ? [{ key: "promote", label: "发布到公共库", icon: <Share2 className="size-4" />, onClick: () => void run(onPromote) }] : []),
        ...(editable && onEdit ? [{ key: "edit", label: "编辑", icon: <Edit3 className="size-4" />, onClick: onEdit }] : []),
        ...(onArchive ? [{ key: "archive", label: "下架", icon: <Archive className="size-4" />, onClick: onArchive }] : []),
        ...(editable && onDelete ? [{ key: "delete", danger: true, label: "删除", icon: <Trash2 className="size-4" />, onClick: onDelete }] : []),
    ];
    return (
        <article className="wb-surface flex min-h-[288px] flex-col overflow-hidden transition-colors hover:border-orange-300 dark:hover:border-orange-800">
            <div className="flex items-center justify-between px-5 pt-5">
                <span className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{promptTargetLabels[item.targetTool]}</span>
                <Tooltip title={item.favorite ? "取消收藏" : "收藏"}><Button disabled={pending} type="text" className="!size-9" aria-label={item.favorite ? "取消收藏" : "收藏"} icon={<Heart className={`size-4 ${item.favorite ? "fill-orange-500 text-orange-500" : ""}`} />} onClick={() => void run(onFavorite)} /></Tooltip>
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-5 pt-3">
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1"><h2 className="line-clamp-2 text-base font-semibold leading-6 text-foreground">{item.title}</h2><p className="mt-1.5 text-xs text-muted-foreground">版本 {item.version} · 已使用 {item.useCount} 次</p></div>
                </div>
                <p className="mt-4 line-clamp-3 text-sm leading-6 text-muted-foreground">{item.prompt}</p>
                <div className="mt-3 flex flex-wrap gap-1">{item.category ? <Tag color="orange">{item.category}</Tag> : null}{item.tags.slice(0, 3).map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
                <div className="mt-auto flex gap-2 pt-4">
                    <Button disabled={pending} type="primary" block className="!h-10" onClick={() => void run(() => onReuse("fill"))} icon={<Play className="size-4" />}>仅填入</Button>
                    <Dropdown disabled={pending} menu={{ items: menu.map((entry) => ({ ...entry, disabled: pending })) }} trigger={["click"]}><Tooltip title="更多操作"><Button disabled={pending} className="!h-10 !w-10" aria-label="更多操作" icon={<Ellipsis className="size-4" />} /></Tooltip></Dropdown>
                </div>
            </div>
        </article>
    );
}
