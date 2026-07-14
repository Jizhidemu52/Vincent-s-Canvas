import { Button, Dropdown, Tag, Tooltip } from "antd";
import { Archive, Copy, Edit3, Ellipsis, Heart, Play, Send, Share2, Trash2 } from "lucide-react";

import { promptTargetLabels, type PromptTemplate } from "@/services/api/prompts";

export function PromptTemplateCard({ item, editable, canSubmit, onReuse, onEdit, onCopy, onDelete, onFavorite, onSubmit, onPromote, onArchive }: {
    item: PromptTemplate; editable?: boolean; canSubmit?: boolean;
    onReuse: (mode: "fill" | "fill_and_generate") => void;
    onEdit?: () => void; onCopy: () => void; onDelete?: () => void; onFavorite: () => void; onSubmit?: () => void; onPromote?: () => void; onArchive?: () => void;
}) {
    const menu = [
        { key: "generate", label: "填入并生成", icon: <Play className="size-4" />, onClick: () => onReuse("fill_and_generate") },
        { key: "copy", label: "复制为我的模板", icon: <Copy className="size-4" />, onClick: onCopy },
        ...(canSubmit && onSubmit ? [{ key: "submit", label: "提交为团队模板", icon: <Send className="size-4" />, onClick: onSubmit }] : []),
        ...(onPromote ? [{ key: "promote", label: "发布到公共库", icon: <Share2 className="size-4" />, onClick: onPromote }] : []),
        ...(editable && onEdit ? [{ key: "edit", label: "编辑", icon: <Edit3 className="size-4" />, onClick: onEdit }] : []),
        ...(onArchive ? [{ key: "archive", label: "下架", icon: <Archive className="size-4" />, onClick: onArchive }] : []),
        ...(editable && onDelete ? [{ key: "delete", danger: true, label: "删除", icon: <Trash2 className="size-4" />, onClick: onDelete }] : []),
    ];
    return (
        <article className="flex min-h-[280px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition hover:border-orange-300 hover:shadow-md dark:border-stone-800 dark:bg-stone-950">
            <div className="flex h-28 items-end bg-[linear-gradient(135deg,#fff7ed,#fed7aa)] p-4 dark:bg-[linear-gradient(135deg,#292524,#431407)]">
                <div className="rounded-md bg-black px-2 py-1 text-xs font-semibold text-white">{promptTargetLabels[item.targetTool]}</div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-4">
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold text-stone-950 dark:text-white">{item.title}</h2><p className="mt-1 text-xs text-stone-500">v{item.version} · 使用 {item.useCount} 次</p></div>
                    <Tooltip title={item.favorite ? "取消收藏" : "收藏"}><Button type="text" size="small" aria-label={item.favorite ? "取消收藏" : "收藏"} icon={<Heart className={`size-4 ${item.favorite ? "fill-orange-500 text-orange-500" : ""}`} />} onClick={onFavorite} /></Tooltip>
                </div>
                <p className="mt-3 line-clamp-3 text-xs leading-5 text-stone-600 dark:text-stone-300">{item.prompt}</p>
                <div className="mt-3 flex flex-wrap gap-1">{item.category ? <Tag color="orange">{item.category}</Tag> : null}{item.tags.slice(0, 3).map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
                <div className="mt-auto flex gap-2 pt-4">
                    <Button type="primary" block onClick={() => onReuse("fill")} icon={<Play className="size-4" />}>仅填入</Button>
                    <Dropdown menu={{ items: menu }} trigger={["click"]}><Tooltip title="更多操作"><Button aria-label="更多操作" icon={<Ellipsis className="size-4" />} /></Tooltip></Dropdown>
                </div>
            </div>
        </article>
    );
}
