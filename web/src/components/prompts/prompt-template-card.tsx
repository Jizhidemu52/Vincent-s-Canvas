import { useUiText } from "@/lib/i18n";
import { Button, Drawer, Dropdown, Tag, Tooltip } from "antd";
import { useState } from "react";
import { Archive, Copy, Edit3, Ellipsis, Frame, Heart, Play, Send, Share2, Trash2 } from "lucide-react";

import { promptTargetLabels, type PromptTemplate } from "@/services/api/prompts";
import { useAsyncAction } from "@/hooks/use-async-action";

export function PromptTemplateCard({ item, editable, canSubmit, onReuse, onInsertToCanvas, onEdit, onCopy, onDelete, onFavorite, onSubmit, onPromote, onArchive }: {
    item: PromptTemplate; editable?: boolean; canSubmit?: boolean;
    onReuse: (mode: "fill" | "fill_and_generate") => void | Promise<void>;
    onInsertToCanvas: () => void;
    onEdit?: () => void; onCopy: () => void | Promise<void>; onDelete?: () => void; onFavorite: () => void | Promise<void>; onSubmit?: () => void | Promise<void>; onPromote?: () => void | Promise<void>; onArchive?: () => void;
}) {
    const t = useUiText();
    const [detailsOpen, setDetailsOpen] = useState(false);
    const targetLabel = t(item.targetTool === "image-generation" ? "图像生成" : item.targetTool === "video" ? "视频生成" : item.targetTool === "canvas" ? "无限画布" : promptTargetLabels[item.targetTool]);
    const fillLabel = `${t("填入")} ${targetLabel}`;
    const { pending, run } = useAsyncAction(`prompt-card:${item.id}`);
    const menu = [
        { key: "generate", label: t("填入并生成"), icon: <Play className="size-4" />, onClick: () => void run(() => onReuse("fill_and_generate")) },
        { key: "copy", label: t("复制为我的模板"), icon: <Copy className="size-4" />, onClick: () => void run(onCopy) },
        ...(canSubmit && onSubmit ? [{ key: "submit", label: t("提交为团队模板"), icon: <Send className="size-4" />, onClick: () => void run(onSubmit) }] : []),
        ...(onPromote ? [{ key: "promote", label: t("发布到公共库"), icon: <Share2 className="size-4" />, onClick: () => void run(onPromote) }] : []),
        ...(editable && onEdit ? [{ key: "edit", label: t("编辑"), icon: <Edit3 className="size-4" />, onClick: onEdit }] : []),
        ...(onArchive ? [{ key: "archive", label: t("下架"), icon: <Archive className="size-4" />, onClick: onArchive }] : []),
        ...(editable && onDelete ? [{ key: "delete", danger: true, label: t("删除"), icon: <Trash2 className="size-4" />, onClick: onDelete }] : []),
    ];
    return (
        <>
        <article className="wb-surface flex min-h-[288px] flex-col overflow-hidden transition-colors hover:border-orange-300 dark:hover:border-orange-800" onClick={(event) => { if (!(event.target as Element).closest("button,a,[role=menuitem]")) setDetailsOpen(true); }}>
            <div className="flex items-center justify-between px-5 pt-5">
                <span className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{targetLabel}</span>
                <Tooltip title={item.favorite ? t("取消收藏") : t("收藏")}><Button disabled={pending} type="text" className="!size-9" aria-label={item.favorite ? t("取消收藏") : t("收藏")} icon={<Heart className={`size-4 ${item.favorite ? "fill-orange-500 text-orange-500" : ""}`} />} onClick={() => void run(onFavorite)} /></Tooltip>
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-5 pt-3">
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1"><h2 className="line-clamp-2 text-base font-semibold leading-6 text-foreground"><button type="button" className="text-left underline-offset-4 hover:underline focus-visible:underline" onClick={() => setDetailsOpen(true)} aria-label={t("查看完整提示词：{p0}", { p0: item.title })}>{item.title}</button></h2><p className="mt-1.5 text-xs text-muted-foreground">{t("版本")} {item.version} {t("· 已使用")} {item.useCount} {t("次")}</p></div>
                </div>
                <p className="mt-4 line-clamp-3 text-sm leading-6 text-muted-foreground">{item.prompt}</p>
                <div className="mt-3 flex flex-wrap gap-1">{item.category ? <Tag color="orange">{item.category}</Tag> : null}{item.tags.slice(0, 3).map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
                <div className="mt-auto space-y-2 pt-4">
                    <Tooltip title={t("仅填入，不自动生成")}><Button disabled={pending} type="primary" block className="!h-10" onClick={() => void run(() => onReuse("fill"))} icon={<Send className="size-4" />}>{fillLabel}</Button></Tooltip>
                    <div className="flex gap-2">
                        <Button disabled={pending} block className="!h-10" onClick={onInsertToCanvas} icon={<Frame className="size-4" />}>{t("插入到画布")}</Button>
                        <Dropdown disabled={pending} menu={{ items: menu.map((entry) => ({ ...entry, disabled: pending })) }} trigger={["click"]}><Tooltip title={t("更多操作")}><Button disabled={pending} className="!h-10 !w-10 shrink-0" aria-label={t("更多操作")} icon={<Ellipsis className="size-4" />} /></Tooltip></Dropdown>
                    </div>
                </div>
            </div>
        </article>
        <Drawer open={detailsOpen} onClose={() => setDetailsOpen(false)} title={item.title} size="large" footer={<Button type="primary" disabled={pending} onClick={() => void run(() => onReuse("fill"))}>{fillLabel}</Button>}>
            <div className="mb-4 flex flex-wrap gap-2"><Tag>{targetLabel}</Tag><Tag>{t("版本")} {item.version}</Tag>{item.category ? <Tag>{item.category}</Tag> : null}{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div>
            <h3 className="mb-2 font-medium">{t("完整提示词")}</h3>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{item.prompt}</p>
            {item.notes ? <><h3 className="mb-2 mt-6 font-medium">{t("使用说明")}</h3><p className="whitespace-pre-wrap break-words text-sm leading-7">{item.notes}</p></> : null}
            {item.referenceAssetIds.length ? <p className="mt-5 text-sm text-muted-foreground">{t("包含 {p0} 张参考图，填入时会核验访问权限。", { p0: String(item.referenceAssetIds.length) })}</p> : null}
            <p className="mt-6 text-xs text-muted-foreground">{t("查看详情不会提交生成或扣除积分；填入后可继续调整。")}</p>
        </Drawer>
        </>
    );
}
