import { useEffect, useRef, useState } from "react";
import { App, Button, Drawer, Tag } from "antd";
import { BookOpen, Copy, Save, Send } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useCopyText } from "@/hooks/use-copy-text";
import { useUiText } from "@/lib/i18n";
import { createPromptActionGuard, promptActionIdentity } from "@/lib/prompt-template-reuse";
import { createPromptTemplate, promptTargetLabels } from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";
import { generalPromptDestination, generalPromptSnapshot, getLocalizedGeneralPrompts, matchingGeneralPrompts, type GeneralPrompt } from "./general-prompts";

export function GeneralPromptCatalog({ query, onClear }: { query: string; onClear: () => void }) {
    const t = useUiText();
    const items = matchingGeneralPrompts(getLocalizedGeneralPrompts(), query);
    return <section aria-label={t("通用提示词")}>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">{t("按公开资料整理的通用起点。替换方括号内的内容后再使用；填入只替换提示词，保留目标页面已有参数和参考图，不会自动生成。")}</p>
        {items.length ? <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map(item => <GeneralPromptCard key={item.id} item={item} />)}</div> : <div className="wb-surface wb-empty"><BookOpen className="size-9" /><strong>{t("没有找到匹配模板")}</strong><p>{t("试试更短的关键词，或清除搜索查看全部内容。")}</p><Button onClick={onClear}>{t("清除搜索")}</Button></div>}
    </section>;
}

function GeneralPromptCard({ item }: { item: GeneralPrompt }) {
    const t = useUiText();
    const navigate = useNavigate();
    const copyText = useCopyText();
    const { message } = App.useApp();
    const identity = useUserStore(promptActionIdentity);
    const { pending, run } = useAsyncAction(`general-prompt:${item.id}`);
    const [open, setOpen] = useState(false);
    const [savedVariantKey, setSavedVariantKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(copyTimer.current), []);
    useEffect(() => { clearTimeout(copyTimer.current); setCopied(false); }, [item.prompt]);
    const copyPrompt = async () => {
        if (!await copyText(item.prompt, t("提示词已复制"))) return;
        clearTimeout(copyTimer.current);
        setCopied(true);
        copyTimer.current = setTimeout(() => setCopied(false), 1200);
    };
    const variantKey = `${identity}:${item.prompt}`;
    const saved = savedVariantKey === variantKey;
    const fillLabel = `${t("填入")} ${t(promptTargetLabels[item.targetTool])}`;
    const fill = () => navigate(generalPromptDestination(item));
    const save = async () => {
        const guard = createPromptActionGuard(identity);
        try {
            guard.assert();
            await createPromptTemplate(generalPromptSnapshot(item));
            if (guard.current()) {
                setSavedVariantKey(variantKey);
                message.success(t("已保存到我的提示词"));
            }
        } finally { guard.dispose(); }
    };
    const actions = <div className="space-y-2">
        <Button block type="primary" className="!h-10" onClick={fill} icon={<Send className="size-4" />}>{fillLabel}</Button>
        <div className="grid grid-cols-2 gap-2">
            <Button disabled={pending} onClick={() => void copyPrompt()} icon={<Copy className="size-4" />}>{copied ? t("已复制 ✓") : t("复制提示词")}</Button>
            <Button disabled={pending || saved} loading={pending} onClick={() => void run(save)} icon={<Save className="size-4" />}>{saved ? t("已存到我的提示词") : t("存到我的提示词")}</Button>
        </div>
    </div>;
    return <>
        <article data-general-prompt-id={item.id} className="wb-surface flex min-w-0 flex-col p-5 transition-colors hover:border-orange-300 dark:hover:border-orange-800">
            <div className="mb-3 flex flex-wrap gap-1"><Tag>{t(promptTargetLabels[item.targetTool])}</Tag><Tag color="orange">{item.category}</Tag></div>
            <h2 className="text-base font-semibold leading-6"><button type="button" className="text-left underline-offset-4 hover:underline focus-visible:underline" onClick={() => setOpen(true)} aria-label={t("查看完整提示词：{p0}", { p0: item.title })}>{item.title}</button></h2>
            <p className="my-4 line-clamp-3 break-words text-sm leading-6 text-muted-foreground">{item.prompt}</p>
            <div className="mb-4 flex flex-wrap gap-1">{item.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</div>
            <div className="mt-auto">{actions}</div>
        </article>
        <Drawer open={open} onClose={() => setOpen(false)} title={item.title} size="large" footer={actions}>
            <div className="mb-4 flex flex-wrap gap-1"><Tag>{t("通用提示词")}</Tag><Tag>{t(promptTargetLabels[item.targetTool])}</Tag><Tag>{item.category}</Tag></div>
            <h3 className="mb-2 font-medium">{t("完整提示词")}</h3>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{item.prompt}</p>
            <h3 className="mb-2 mt-6 font-medium">{t("使用说明")}</h3>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{item.notes}</p>
            <h3 className="mb-2 mt-6 font-medium">{t("参考来源")}</h3>
            <ul className="space-y-2 text-sm leading-6">{item.sources.map(source => <li key={source.url}><a className="break-words underline underline-offset-4" href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ul>
            <p className="mt-6 text-xs leading-6 text-muted-foreground">{t("通用模板不是生成记录，也不代表已逐项实测。查看、复制和填入不会提交生成任务。")}</p>
        </Drawer>
    </>;
}
